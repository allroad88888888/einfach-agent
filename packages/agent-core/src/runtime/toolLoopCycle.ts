import type { ModelItem } from '@web-agent/ai'
import { appendItem, patchRun } from '../state/sessionWriters'
import { FINISH_REASON_ITEM_NOTICES } from './core/plugins/finishReasonPlugin'
import { getAbnormalFinishReason, type TurnEndEvent } from './core/loopHooks'
import type { LoopBudget } from './loopBudget'
import type { ModelTurnRequester } from './modelTurnRequester'
import type { RequestControlSource } from './contextRequestAssemblyDiagnostics'
import { newId } from './newId'
import { assistantItemFromMessage } from './shared/preview'
import { runToolCallBatch } from './toolCallBatch'
import type { ToolFailureTracker } from './toolFailureTracker'
import type { ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import type { ToolLoopBase } from './toolLoopContracts'
import { currentPlanContext, currentPlanStageId } from './toolLoopPlan'
import { stopOverBudgetPlanStage } from './toolLoopPlanStageGuard'
import { handleTextTurn } from './toolLoopTextTurn'
import { safeErrorMessage } from './toolLoopSupport'

export type ToolLoopCycleResult = 'continue' | 'finished'

export interface ToolLoopTerminator {
  (streamWriter?: { finishPending(): void }): boolean
}

/** Runs a complete model-response cycle inside the outer loop state machine. */
export async function runToolLoopCycle(input: {
  base: ToolLoopBase
  checkpoints: ToolLoopCheckpointWriter
  requester: ModelTurnRequester
  budget: LoopBudget
  failures: ToolFailureTracker
  turn: number
  endInactive: ToolLoopTerminator
}): Promise<ToolLoopCycleResult> {
  const { base, checkpoints, requester, budget, failures, turn, endInactive } = input
  if (endInactive()) return 'finished'
  const promoted = base.promoteQueuedInputs()
  if (promoted) {
    budget.includeQueuedInputs(promoted)
    failures.reset()
  }
  budget.syncPlanFloor()
  const planStageId = currentPlanStageId(base.id, base.core)
  if (planStageId && stopOverBudgetPlanStage(base, checkpoints.persistWorkingTurn, planStageId)) return 'finished'
  const failureNotice = failures.consume()
  if (failureNotice) base.trace.event('agent.tool_failure_notice', { tools: failureNotice.tools })
  const planContext = currentPlanContext(base.id, base.core)
  const planContinuation = base.state.planContinuation
  const controls: ModelItem[] = []
  const controlSources: RequestControlSource[] = []
  if (planContext) {
    controls.push({ role: 'system', content: planContext })
    controlSources.push('plan_snapshot')
  }
  if (planContinuation) {
    controls.push({ role: 'system', content: planContinuation })
    controlSources.push('plan_continuation')
  }
  if (failureNotice) {
    controls.push({ role: 'system', content: failureNotice.text })
    controlSources.push('tool_failure_notice')
  }
  base.state.planContinuation = undefined
  const modelTurn = await requester.request(turn, planStageId, controls, controlSources)
  if ('inactive' in modelTurn) {
    endInactive(modelTurn.streamWriter)
    return 'finished'
  }
  if (endInactive(modelTurn.streamWriter)) return 'finished'

  const finishReason = modelTurn.choice?.finish_reason ?? null
  if (finishReason === 'length' && modelTurn.toolCalls.length) {
    base.trace.event('llm.finish_length_tool_calls', {
      finish_reason: finishReason,
      tool_calls_count: modelTurn.toolCalls.length,
      hint: '输出触顶，tool_call 参数可能被截断',
    })
  }
  const assistantHasContent = typeof modelTurn.message?.content === 'string' && modelTurn.message.content.trim().length > 0
  const turnEnd: TurnEndEvent = {
    finishReason,
    toolCalls: modelTurn.toolCalls,
    assistantHasContent,
    msg: modelTurn.message,
    hasStreamedItem: modelTurn.streamWriter.hasItem(),
  }
  const abnormal = getAbnormalFinishReason(turnEnd)
  if (abnormal) modelTurn.streamWriter.finalize(modelTurn.message, undefined, FINISH_REASON_ITEM_NOTICES[abnormal])
  const decision = await base.hooks.onTurnEnd?.(base.pluginContext, turnEnd)
  if (endInactive(modelTurn.streamWriter)) return 'finished'
  if (decision?.stop) {
    if (abnormal) {
      checkpoints.commitTurn({ kind: 'abnormal', finishReason: abnormal })
      if (base.control.isCurrent()) patchRun(base.id, { status: decision.runStatus, error: decision.reason }, base.core)
      base.trace.finish('error', decision.traceEventName, {
        finish_reason: finishReason,
        tool_calls_count: modelTurn.toolCalls.length,
        content_chars: modelTurn.message?.content?.length ?? 0,
        error: decision.reason,
      })
    } else {
      modelTurn.streamWriter.finishPending()
      checkpoints.commitTurn()
      if (base.control.isCurrent()) patchRun(base.id, { status: decision.runStatus, error: decision.reason }, base.core)
      base.trace.finish('error', decision.traceEventName, decision.traceAttrs)
    }
    return 'finished'
  }
  let pluginStop
  try {
    pluginStop = await base.hooks.shouldStop?.(base.pluginContext, turnEnd)
  } catch (error) {
    const message = safeErrorMessage(error)
    modelTurn.streamWriter.finishPending()
    if (base.control.isCurrent()) patchRun(base.id, { status: 'error', error: message }, base.core)
    checkpoints.commitTurn({ kind: 'abnormal', finishReason: 'plugin_should_stop_failed' })
    base.trace.finish('error', 'agent.plugin_should_stop_failed', { error: message }, error)
    return 'finished'
  }
  if (endInactive(modelTurn.streamWriter)) return 'finished'
  if (pluginStop) {
    modelTurn.streamWriter.finishPending()
    if (base.control.isCurrent()) patchRun(base.id, { status: pluginStop.runStatus, error: pluginStop.reason }, base.core)
    checkpoints.commitStoppedTurn()
    base.trace.finish('cancelled', 'agent.plugin_should_stop', {
      reason: pluginStop.reason,
      run_status: pluginStop.runStatus,
      checkpoint_kind: pluginStop.checkpoint.kind,
    })
    return 'finished'
  }
  const streamedItemId = modelTurn.streamWriter.finalize(modelTurn.message, modelTurn.toolCalls)
  if (!modelTurn.toolCalls.length) {
    return handleTextTurn({
      base,
      checkpoints,
      message: modelTurn.message,
      streamedItemId,
      planStageId,
      budget,
      failures,
    }) ? 'finished' : 'continue'
  }

  base.state.consecutivePlanTextTurns = 0
  if (!streamedItemId) {
    appendItem(base.id, {
      id: newId(),
      createdAt: Date.now(),
      planStageId,
      item: assistantItemFromMessage(modelTurn.message, modelTurn.message?.content ?? null, modelTurn.toolCalls),
    }, base.core)
  }
  checkpoints.persistWorkingTurn()
  const batch = await runToolCallBatch(base, {
    result: modelTurn,
    planStageId,
    finishReason,
    persistWorkingTurn: checkpoints.persistWorkingTurn,
    recordToolOutcome: failures.record,
  })
  if (batch === 'continue') return 'continue'
  if (batch === 'paused') return 'finished'
  if (batch === 'stale') {
    base.trace.finish('cancelled', 'agent.stale_run', { reason: 'stale_run' })
    return 'finished'
  }
  if (batch === 'stopped') {
    checkpoints.commitStoppedTurn()
    base.trace.finish('cancelled', 'agent.stopped', { reason: 'run_not_running' })
    return 'finished'
  }
  patchRun(base.id, { status: 'stopped' }, base.core)
  checkpoints.commitStoppedTurn()
  base.trace.finish('cancelled', 'agent.stopped', { reason: 'aborted' })
  return 'finished'
}
