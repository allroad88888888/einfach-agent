import type { ToolCallOutcomeFact } from '../state/core.type'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import { COMPACT_CONTEXT_TOOL_NAME } from '../tools/contextCompaction'
import type { CoreInstance } from './core/coreInstance'

/** Only the built-in summary call can be retried without reconciling an external effect. */
export function isInterruptedContextCompaction(
  callId: string,
  runId: string,
  outcome: ToolCallOutcomeFact,
  hasReceipt: boolean,
): boolean {
  if (hasReceipt || outcome.state === 'outcomeKnown') return false
  const prefix = `timed:compact:${runId}:`
  if (!callId.startsWith(prefix)) return false
  const parts = callId.slice(prefix.length).split(':')
  return parts.length === 2 && /^(0|[1-9]\d*)$/.test(parts[0]) && parts[1] === COMPACT_CONTEXT_TOOL_NAME
}

/**
 * Compaction's durable effect is already in contextCheckpoint. Keep that state and
 * remove only an unfinished dispatch fence; the normal budget/projection path will
 * reuse a valid checkpoint or request another summary. Do not invent a receipt:
 * it would cause timed dispatch to skip the retry at the same request epoch.
 * The caller must persist this recovery before resuming the model loop.
 */
export function resetInterruptedContextCompaction(sessionId: string, core: CoreInstance): boolean {
  const store = core.getSessionStore(sessionId).store
  const run = store.getter(runAtom)
  if (!run) return false
  const receipts = new Set(store.getter(itemsAtom).flatMap(({ item }) => (
    item.role === 'tool' ? [item.tool_call_id] : []
  )))
  const outcomes = { ...run.toolCallOutcomes }
  let changed = false
  for (const [callId, outcome] of Object.entries(outcomes)) {
    if (!isInterruptedContextCompaction(callId, run.runId, outcome, receipts.has(callId))) continue
    delete outcomes[callId]
    changed = true
  }
  if (changed) patchRun(sessionId, { toolCallOutcomes: outcomes }, core)
  return changed
}
