import { runAtom } from '../state/sessionAtoms'
import type { CoreInstance } from './core/coreInstance'
import { appendToolResult } from './toolLoopSupport'
import { unresolvedToolCalls } from './toolCallOutcomeFacts'
import { isPureTool } from './toolReversibility'

export type InterruptedToolCallRecovery = 'ready' | 'reconciliation_required'

/**
 * Resolves the calls an interrupted run can safely settle before it continues.
 *
 * Two kinds qualify, and they get different receipts because the model must be
 * able to tell them apart:
 * - provably unstarted: nothing ran, so the call simply did not happen;
 * - outcome unknown but the tool is pure: repeating it cannot change the outside
 *   world, so the model is told the result is unknown and may be re-fetched.
 *
 * Everything else stays fail-closed as `reconciliation_required`: a call whose
 * external effect may or may not have landed is the user's call, not ours.
 */
export async function recoverInterruptedToolCalls(
  sessionId: string,
  core: CoreInstance,
): Promise<InterruptedToolCallRecovery> {
  const calls = unresolvedToolCalls(sessionId, core)
  if (!calls.length) return 'ready'
  const run = core.getSessionStore(sessionId).store.getter(runAtom)
  const settleable = (call: { callId: string; name: string }): boolean => {
    const state = run?.toolCallOutcomes?.[call.callId]?.state
    return state === 'notStarted' || (state === 'outcomeUnknown' && isPureTool(call.name))
  }
  const blocked = calls.filter((call) => !settleable(call))
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
  let settledPure = false
  for (const call of calls) {
    const unstarted = run?.toolCallOutcomes?.[call.callId]?.state === 'notStarted'
    if (!unstarted) settledPure = true
    appendToolResult(sessionId, call.callId, JSON.stringify(unstarted
      ? {
        error: `工具 ${call.name} 在中断前尚未开始执行。`,
        interrupted: true,
        result: 'not_started',
      }
      : {
        error: `工具 ${call.name} 在中断时结果未知。该工具只读、重复执行不改变外部状态，需要结果请重新调用。`,
        interrupted: true,
        result: 'unknown_pure_retryable',
      }), core, call.planStageId)
  }
  try {
    const reason = settledPure
      ? 'interrupted_tool_calls_unknown_pure'
      : 'interrupted_tool_calls_not_started'
    const outcome = await core.persistence.persistRecovery(sessionId, reason)
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
