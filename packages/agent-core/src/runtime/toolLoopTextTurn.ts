import type { ModelResponseMessage } from '@web-agent/ai'
import { planAtom } from '../state/sessionAtoms'
import { appendItem, patchRun } from '../state/sessionWriters'
import { assistantItemFromMessage } from './shared/preview'
import type { LoopBudget } from './loopBudget'
import { newId } from './newId'
import type { ToolFailureTracker } from './toolFailureTracker'
import type { ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import type { ToolLoopBase } from './toolLoopContracts'
import { EXECUTING_PLAN_STATUSES, planContinuationNotice } from './toolLoopPlan'
import { requireRecoveryDurability } from './recoveryDurabilityBarrier'
import { advanceTimedDispatchEpoch } from './timedDispatchEpoch'

/** Records a model text response and decides whether its loop should continue. */
export async function handleTextTurn(input: {
  base: ToolLoopBase
  checkpoints: ToolLoopCheckpointWriter
  message: ModelResponseMessage | undefined
  streamedItemId: string | undefined
  planStageId: string | undefined
  budget: LoopBudget
  failures: ToolFailureTracker
}): Promise<boolean> {
  const { base, checkpoints, message, streamedItemId, planStageId, budget, failures } = input
  const content = message?.content
  if (!content || !content.trim()) {
    if (base.control.isRunning()) patchRun(base.id, { status: 'error', error: '模型返回空回复' }, base.core)
    checkpoints.persistWorkingTurn()
    base.trace.finish('error', 'agent.error', { error: '模型返回空回复' })
    return true
  }
  if (!streamedItemId) {
    appendItem(base.id, {
      id: newId(),
      createdAt: Date.now(),
      ...(planStageId !== undefined ? { planStageId } : {}),
      item: assistantItemFromMessage(message, content),
    }, base.core)
  }
  advanceTimedDispatchEpoch(base)
  const plan = base.core.getSessionStore(base.id).store.getter(planAtom)
  if (plan && EXECUTING_PLAN_STATUSES.has(plan.status)) {
    base.state.consecutivePlanTextTurns += 1
    const stage = plan.stages.find((entry) => entry.status === 'in_progress')
    if (base.state.consecutivePlanTextTurns >= 2) {
      const error = '计划执行连续 2 轮未调用工具，已停止自动续跑'
      if (base.control.isRunning()) patchRun(base.id, { status: 'error', error }, base.core)
      checkpoints.persistWorkingTurn()
      base.trace.finish('error', 'agent.plan_continuation_stalled', {
        planId: plan.id,
        planStatus: plan.status,
        stageId: stage?.id,
        consecutive_text_turns: base.state.consecutivePlanTextTurns,
        error,
      })
      return await persistTextResponse(input, true)
    }
    base.state.planContinuation = planContinuationNotice(
      plan.id,
      plan.status,
      stage && { id: stage.id, title: stage.title, status: stage.status },
      base.state.lastStageSubmitRejection,
    )
    base.trace.event('agent.plan_continuation_required', {
      planId: plan.id,
      planStatus: plan.status,
      stageId: stage?.id,
      submit_rejected: base.state.lastStageSubmitRejection !== undefined,
    })
    checkpoints.persistWorkingTurn()
    return await persistTextResponse(input, false)
  }
  const promoted = base.promoteQueuedInputs()
  if (promoted) {
    budget.includeQueuedInputs(promoted)
    failures.reset()
    checkpoints.persistWorkingTurn()
    return await persistTextResponse(input, false)
  }
  checkpoints.commitTurn()
  if (base.control.isRunning()) patchRun(base.id, { status: 'done', finishedAt: Date.now() }, base.core)
  base.trace.finish('ok', 'agent.done', { status: 'done' })
  return await persistTextResponse(input, true)
}

async function persistTextResponse(
  input: Parameters<typeof handleTextTurn>[0],
  finished: boolean,
): Promise<boolean> {
  const { base, checkpoints } = input
  checkpoints.persistWorkingTurn()
  if (await requireRecoveryDurability(base.id, base.runId, base.core, 'model_text_response_saved')) return finished
  checkpoints.commitStoppedTurn()
  base.trace.finish('cancelled', 'agent.recovery_fence_failed', { reason: 'recovery_fence_failed' })
  return true
}
