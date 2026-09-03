import type { ToolCallOutcomeState } from '../state/core.type'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import { currentTurnStartIndex } from './activeTurnItems'
import type { CoreInstance } from './core/coreInstance'

export interface UnresolvedToolCall {
  callId: string
  name: string
  planStageId?: string
}

/** Updates the canonical durable outcome fact for each listed tool call. */
export function setToolCallOutcomeFacts(
  sessionId: string,
  callIds: readonly string[],
  state: ToolCallOutcomeState,
  core: CoreInstance,
): void {
  const uniqueIds = [...new Set(callIds.filter((callId) => callId.length > 0))]
  if (!uniqueIds.length) return
  const run = core.getSessionStore(sessionId).store.getter(runAtom)
  if (!run) return
  const updatedAt = Date.now()
  const outcomes = { ...run.toolCallOutcomes }
  for (const callId of uniqueIds) outcomes[callId] = { state, updatedAt }
  patchRun(sessionId, { toolCallOutcomes: outcomes }, core)
}

/** Returns calls in the active turn that have no transcript tool receipt. */
export function unresolvedToolCalls(sessionId: string, core: CoreInstance): UnresolvedToolCall[] {
  const store = core.getSessionStore(sessionId).store
  const items = store.getter(itemsAtom)
  const turnId = store.getter(runAtom)?.turnId
  const start = currentTurnStartIndex(items, turnId)
  const unresolved = new Map<string, UnresolvedToolCall>()
  for (const entry of items.slice(start)) {
    if (entry.item.role === 'assistant') {
      for (const call of entry.item.tool_calls ?? []) {
        unresolved.set(call.id, { callId: call.id, name: call.function.name, planStageId: entry.planStageId })
      }
    } else if (entry.item.role === 'tool') {
      unresolved.delete(entry.item.tool_call_id)
    }
  }
  return [...unresolved.values()]
}

/** Marks every unpaired assistant tool call as externally indeterminate. */
export function markUnresolvedToolCallsOutcomeUnknown(sessionId: string, core: CoreInstance): UnresolvedToolCall[] {
  const calls = unresolvedToolCalls(sessionId, core)
  setToolCallOutcomeFacts(sessionId, calls.map((call) => call.callId), 'outcomeUnknown', core)
  return calls
}
