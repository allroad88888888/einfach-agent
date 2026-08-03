import { isAbortError } from '@web-agent/ai'
import { patchRun } from '../state/sessionWriters'
import { createLoopBudget } from './loopBudget'
import { createModelTurnRequester } from './modelTurnRequester'
import { continueInterruptedModelRun, continuePlanModelRun, startModelRun, type ModelRunOptions, type ToolLoopOptions } from './modelRunLifecycle'
import { bootstrapToolLoop } from './toolLoopBootstrap'
import { runToolLoopCycle, type ToolLoopTerminator } from './toolLoopCycle'
import { createToolFailureTracker } from './toolFailureTracker'
import { currentPlanStageId, maxAgentTurns } from './toolLoopPlan'
import { appendMappedToolResult, safeErrorMessage } from './toolLoopSupport'
import { executePreparedToolCall, prepareToolCall } from './toolCallPluginHooks'
import { addEvent } from '../observability/trace'

export { persistCurrentRunRecovery } from './runCheckpoints'

/** Starts a new public model-run lifecycle. */
export async function runSession(id: string, input: string, opts: ModelRunOptions): Promise<void> {
  await startModelRun(id, input, opts, runToolLoop)
}

/** Continues a persisted run whose process was interrupted. */
export async function resumeInterruptedSession(id: string, opts: ModelRunOptions): Promise<void> {
  await continueInterruptedModelRun(id, opts, runToolLoop)
}

/** Continues a persisted execution plan in a fresh runtime process. */
export async function resumePlanSession(id: string, opts: ModelRunOptions & { runId?: string; turnId?: string }): Promise<void> {
  await continuePlanModelRun(id, opts, runToolLoop)
}

/** Drives the main-agent state machine; model I/O and tool policies live in focused collaborators. */
export async function runToolLoop(id: string, runId: string, opts: ToolLoopOptions): Promise<void> {
  const boot = await bootstrapToolLoop(id, runId, opts)
  if (!boot) return
  const { base, checkpoints } = boot
  const endInactive: ToolLoopTerminator = (streamWriter) => {
    if (!base.control.isCurrent()) {
      streamWriter?.finishPending()
      base.trace.finish('cancelled', 'agent.stale_run', { reason: 'stale_run' })
      return true
    }
    if (!base.control.isRunning()) {
      streamWriter?.finishPending()
      checkpoints.commitStoppedTurn()
      base.trace.finish('cancelled', 'agent.stopped', { reason: 'run_not_running' })
      return true
    }
    if (base.opts.signal.aborted) {
      streamWriter?.finishPending()
      patchRun(id, { status: 'stopped' }, base.core)
      checkpoints.commitStoppedTurn()
      base.trace.finish('cancelled', 'agent.stopped', { reason: 'aborted' })
      return true
    }
    return false
  }
  try {
    if (opts.resumeToolCall) {
      const pending = opts.resumeToolCall
      const call = {
        callId: pending.callId,
        name: pending.toolName,
        args: pending.args,
        registrationVersion: pending.registrationVersion,
        resumed: true,
      }
      const preparation = pending.beforeToolHookCompleted
        ? {
            kind: 'ready' as const,
            prepared: {
              call,
              ...(pending.schemaWarnings ? { schemaWarnings: pending.schemaWarnings } : {}),
              beforeToolHookCompleted: true as const,
            },
          }
        : await prepareToolCall(base, call)
      if (endInactive()) return
      if (preparation.kind === 'rejected') {
        appendMappedToolResult(id, pending.callId, preparation.result, base.core, currentPlanStageId(id, base.core))
      } else {
        const resumed = await executePreparedToolCall(base, preparation.prepared)
        if (endInactive()) return
        appendMappedToolResult(id, pending.callId, resumed, base.core, currentPlanStageId(id, base.core))
      }
    }
    const budget = createLoopBudget(maxAgentTurns(id, base.core), () => maxAgentTurns(id, base.core))
    const failures = createToolFailureTracker()
    const requester = createModelTurnRequester(base)
    for (let turn = 0; budget.allows(turn); turn += 1) {
      if ((await runToolLoopCycle({ base, checkpoints, requester, budget, failures, turn, endInactive })) === 'finished') return
    }
    checkpoints.commitTurn()
    const error = `主 Agent 超过最大模型轮次（${budget.limit()}）`
    if (base.control.isRunning()) patchRun(id, { status: 'error', error }, base.core)
    base.trace.finish('error', 'agent.max_turns', { max_turns: budget.limit(), error })
  } catch (error) {
    if (isAbortError(error)) {
      if (base.control.isCurrent()) patchRun(id, { status: 'stopped' }, base.core)
      checkpoints.commitStoppedTurn()
      base.trace.finish('cancelled', 'agent.stopped', { reason: 'abort_error' }, error)
    } else {
      if (base.control.isRunning()) patchRun(id, { status: 'error', error: safeErrorMessage(error) }, base.core)
      checkpoints.persistWorkingTurn()
      base.trace.finish('error', 'agent.error', { error: safeErrorMessage(error) }, error)
    }
  } finally {
    try { base.pluginRun.dispose() }
    catch (error) { addEvent('agent.plugin_dispose_failed', { traceId: base.trace.span.traceId, attrs: { sessionId: id, runId, turnId: base.turnId, error: safeErrorMessage(error), aborted: isAbortError(error) || opts.signal.aborted } }) }
    try { await base.delegateRuntime.dispose?.() }
    catch (error) { addEvent('agent.dispose_failed', { traceId: base.trace.span.traceId, attrs: { sessionId: id, runId, turnId: base.turnId, error: safeErrorMessage(error), aborted: isAbortError(error) || opts.signal.aborted } }) }
  }
}
