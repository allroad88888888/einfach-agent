import { runAtom } from '../state/sessionAtoms'
import type { CoreInstance } from './core/coreInstance'
import { appendToolResult } from './toolLoopSupport'
import { unresolvedToolCalls } from './toolCallOutcomeFacts'

export type InterruptedToolCallRecovery = 'ready' | 'reconciliation_required'

/** Resolves only provably unstarted calls before an interrupted model run may continue. */
export async function recoverInterruptedToolCalls(
  sessionId: string,
  core: CoreInstance,
): Promise<InterruptedToolCallRecovery> {
  const calls = unresolvedToolCalls(sessionId, core)
  if (!calls.length) return 'ready'
  const run = core.getSessionStore(sessionId).store.getter(runAtom)
  const blocked = calls.filter((call) => run?.toolCallOutcomes?.[call.callId]?.state !== 'notStarted')
  if (blocked.length) {
    core.observability.addEvent('agent.tool_reconciliation_required', {
      attrs: {
        sessionId,
        runId: run?.runId,
        callIds: blocked.map((call) => call.callId),
        states: blocked.map((call) => run?.toolCallOutcomes?.[call.callId]?.state ?? 'missing'),
      },
    })
    return 'reconciliation_required'
  }
  for (const call of calls) {
    appendToolResult(sessionId, call.callId, JSON.stringify({
      error: `工具 ${call.name} 在中断前尚未开始执行。`,
      interrupted: true,
      result: 'not_started',
    }), core, call.planStageId)
  }
  try {
    const outcome = await core.persistence.persistRecovery(sessionId, 'interrupted_tool_calls_not_started')
    if (outcome === undefined || outcome.status === 'saved') return 'ready'
    core.observability.addEvent('agent.tool_reconciliation_required', {
      attrs: { sessionId, runId: run?.runId, reason: `recovery_${outcome.status}` },
    })
  } catch (error) {
    core.observability.addEvent('agent.tool_reconciliation_required', {
      attrs: {
        sessionId,
        runId: run?.runId,
        reason: 'recovery_error',
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
  return 'reconciliation_required'
}
