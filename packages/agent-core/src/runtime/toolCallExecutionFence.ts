import { runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import type { RunState } from '../state/core.type'
import type { ToolLoopBase } from './toolLoopContracts'
import { safeErrorMessage } from './toolLoopSupport'
import { setToolCallOutcomeFacts } from './toolCallOutcomeFacts'

/** Persists an indeterminate outcome before an executor may cause an external effect. */
export async function persistToolCallExecutionFence(
  base: ToolLoopBase,
  callIds: readonly string[],
): Promise<boolean> {
  setToolCallOutcomeFacts(base.id, callIds, 'outcomeUnknown', base.core)
  try {
    const outcome = await base.core.persistence.persistRecovery(base.id, 'tool_call_execution_started')
    if (outcome === undefined || outcome.status === 'saved') return true
    return failFence(base, callIds, `Recovery persistence returned ${outcome.status}.`)
  } catch (error) {
    return failFence(base, callIds, safeErrorMessage(error))
  }
}

function failFence(base: ToolLoopBase, callIds: readonly string[], error: string): false {
  setToolCallOutcomeFacts(base.id, callIds, 'notStarted', base.core)
  const store = base.core.getSessionStore(base.id).store
  const run = store.getter(runAtom)
  if (run) {
    setRun(base.id, withoutUndefined({
      ...run,
      status: 'interrupted',
      error: `工具执行前的恢复快照未确认：${error}`,
    }), base.core)
  }
  base.core.observability.addEvent('agent.tool_execution_fence_failed', {
    span: base.trace.span,
    attrs: { sessionId: base.id, runId: base.runId, callIds: [...callIds], error },
  })
  void base.core.persistence.persistRecovery(base.id, 'tool_call_execution_fence_failed')
  return false
}

function withoutUndefined(run: RunState): RunState {
  return Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)) as RunState
}
