import type { ToolCallTiming } from '../tools/toolCallTiming'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import type { ToolLoopBase } from './toolLoopContracts'

interface TimedRecoveryRequest {
  timing: ToolCallTiming
}

/** Refuses a repeated timed side effect when a previous dispatch has no durable outcome. */
export function requiresTimedToolReconciliation(input: {
  base: ToolLoopBase
  request: TimedRecoveryRequest
  name: string
  callId: string
  isRecorded(callId: string): boolean
}): boolean {
  const { base, request, name, callId } = input
  const run = base.core.getSessionStore(base.id).store.getter(runAtom)
  const facts = run?.toolCallOutcomes ?? {}
  const fact = facts[callId]
  if (fact?.state === 'outcomeKnown' && input.isRecorded(callId)) return false
  const unresolved = fact ?? Object.entries(facts).find(([candidate, outcome]) => (
    outcome.state !== 'outcomeKnown' && isUnresolvedTimedCall(candidate, base, request, name)
  ))?.[1]
  if (!unresolved) return false
  return interruptForTimedReconciliation(base, callId, unresolved.state, 'timed_dispatch')
}

/**
 * Stops a resumed run before any model or context work if any timing bucket has
 * an unresolved durable effect. This deliberately crosses bucket boundaries:
 * a crashed turnEnd/preCompact/postCompact fence must not be hidden by a later
 * turnStart dispatch.
 */
export function requiresRunTimedToolReconciliation(base: ToolLoopBase): boolean {
  const store = base.core.getSessionStore(base.id).store
  const facts = store.getter(runAtom)?.toolCallOutcomes ?? {}
  const unresolved = Object.entries(facts).find(([callId, outcome]) => (
    isTimedCallForRun(callId, base.runId) && (
      outcome.state !== 'outcomeKnown' || !hasTimedReceipt(base, callId)
    )
  ))
  if (!unresolved) return false
  const [callId, outcome] = unresolved
  return interruptForTimedReconciliation(base, callId, outcome.state, 'timed_pre_model_gate')
}

function interruptForTimedReconciliation(
  base: ToolLoopBase,
  callId: string,
  state: string,
  source: string,
): true {
  patchRun(base.id, {
    status: 'interrupted',
    error: `到点工具 ${callId} 的既有执行结果无法安全恢复。`,
  }, base.core)
  base.core.observability.addEvent('agent.tool_reconciliation_required', {
    span: base.trace.span,
    attrs: { sessionId: base.id, runId: base.runId, callId, state, source },
  })
  return true
}

function hasTimedReceipt(base: ToolLoopBase, callId: string): boolean {
  return base.core.getSessionStore(base.id).store.getter(itemsAtom).some(({ item }) => (
    item.role === 'tool' && item.tool_call_id === callId
  ))
}

function isTimedCallForRun(callId: string, runId: string): boolean {
  if (!callId.startsWith('timed:')) return false
  if (callId.startsWith('timed:sessionStart:')) return true
  return callId.split(':')[2] === runId
}

function isUnresolvedTimedCall(
  candidate: string,
  base: ToolLoopBase,
  request: TimedRecoveryRequest,
  name: string,
): boolean {
  if (request.timing === 'sessionStart') return candidate === `timed:sessionStart:${name}`
  if (request.timing === 'runStart' || request.timing === 'runEnd') {
    return candidate === `timed:${request.timing}:${base.runId}:${name}`
  }
  return candidate.startsWith(`timed:${request.timing}:${base.runId}:`) && candidate.endsWith(`:${name}`)
}
