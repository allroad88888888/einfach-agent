import { runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import type { RunState } from '../state/core.type'
import type { CoreInstance } from './core/coreInstance'
import { safeErrorMessage } from './toolLoopSupport'

/** Requires queued recovery writes to be acknowledged before another external boundary. */
export async function requireRecoveryDurability(
  sessionId: string,
  runId: string | undefined,
  core: CoreInstance,
  reason: string,
): Promise<boolean> {
  try {
    const outcome = await core.persistence.persistRecovery(sessionId, reason)
    if (outcome === undefined || outcome.status === 'saved') return true
    return interruptForRecoveryFailure(sessionId, runId, core, `Recovery persistence returned ${outcome.status}.`)
  } catch (error) {
    return interruptForRecoveryFailure(sessionId, runId, core, safeErrorMessage(error))
  }
}

function interruptForRecoveryFailure(
  sessionId: string,
  runId: string | undefined,
  core: CoreInstance,
  error: string,
): false {
  const store = core.getSessionStore(sessionId).store
  const run = store.getter(runAtom)
  if (run) setRun(sessionId, withoutUndefined({
    ...run,
    status: 'interrupted',
    error: `恢复快照未确认：${error}`,
  }), core)
  core.observability.addEvent('agent.recovery_durability_barrier_failed', {
    attrs: { sessionId, runId, reason: 'recovery_durability_unacknowledged', error },
  })
  return false
}

function withoutUndefined(run: RunState): RunState {
  return Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)) as RunState
}
