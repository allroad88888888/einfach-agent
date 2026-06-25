import type { Store } from '@einfach/core'
import type { ModelAdapter } from '../model'
import {
  getConversationMemory,
  messagesBySessionAtom,
  setConversationMemory,
  type ConversationMemory,
} from '../state/atoms'
import { collectCompletedTurns } from './conversation-context'
import type { ChatMessage } from './types'

// D-mem-2: two distinct constants (codex🟩). TRIGGER = how many UNsummarized
// completed turns must accumulate before we compress; RAW_WINDOW = how many most
// recent completed turns are ALWAYS kept as raw原文 (never compressed).
export const SUMMARY_TRIGGER_TURNS = 6
export const RAW_WINDOW_TURNS = 3

export interface SummaryPlan {
  baseCursor: number
  baseSummary: string
  targetCursor: number
  windowMessages: { role: 'user' | 'assistant'; content: string }[]
}

/**
 * M2.2 (pure): decide whether/what to compress. Counts UNsummarized completed
 * turns in `[summarizedUpTo, messages.length)` (reusing the M1 eligible +
 * completed-turn logic). Returns null below `SUMMARY_TRIGGER_TURNS`. Otherwise
 * compresses every turn EXCEPT the most recent `RAW_WINDOW_TURNS` (which always
 * stay raw); the new cursor lands on the first kept-raw turn's user message so
 * the raw window is never swallowed.
 */
export function planSummaryCompression(
  messages: ChatMessage[],
  memory: ConversationMemory,
): SummaryPlan | null {
  const baseCursor = Math.max(0, memory.summarizedUpTo)
  const turns = collectCompletedTurns(messages, baseCursor, messages.length)
  if (turns.length < SUMMARY_TRIGGER_TURNS) return null

  const compressCount = turns.length - RAW_WINDOW_TURNS
  if (compressCount <= 0) return null

  const firstKept = turns[compressCount]
  const targetCursor = firstKept.user.index

  const windowMessages = turns.slice(0, compressCount).flatMap((turn) => [
    { role: 'user' as const, content: turn.user.content },
    { role: 'assistant' as const, content: turn.assistant.content },
  ])

  return {
    baseCursor,
    baseSummary: memory.summary,
    targetCursor,
    windowMessages,
  }
}

// M2.4 / MS2: one in-flight summarize per (store, session). Keyed by Store via a
// WeakMap so concurrent stores (e.g. tests sharing the default session id) never
// block each other; the inner Set tracks per-session single-flight within a store.
const inFlightByStore = new WeakMap<Store, Set<string>>()

function inFlightSet(store: Store): Set<string> {
  let set = inFlightByStore.get(store)
  if (!set) {
    set = new Set<string>()
    inFlightByStore.set(store, set)
  }
  return set
}

/**
 * M2.4/M2.5: run a compression for one session.
 *  - single-flight (MS2): bail if one is already running for THIS (store,
 *    session); a different store with the same session id is independent.
 *  - CAS write-back (MS1): snapshot {baseCursor, baseSummary, targetCursor};
 *    after summarize, re-read the memory and commit ONLY if BOTH the cursor is
 *    still baseCursor AND the summary is still baseSummary (else a newer run
 *    already changed the memory → discard this stale result). The commit goes
 *    through setConversationMemory, which no-ops when the session was deleted
 *    (ghost guard, RF8).
 *  - degradation: summarize failure (non-Abort) is swallowed — cursor NOT
 *    advanced, summary NOT written; the next run reads the old cursor and
 *    re-injects the un-summarized原文.
 *
 * Fire-and-forget: never throws — even AbortError is caught and returns
 * silently, without advancing the cursor (MS4). The `finally` clears the
 * single-flight flag on every path (success / failure / abort).
 */
export async function runSummaryCompression(
  store: Store,
  sessionId: string,
  modelAdapter: ModelAdapter,
): Promise<void> {
  const flight = inFlightSet(store)
  if (flight.has(sessionId)) return
  flight.add(sessionId)

  try {
    const messages = store.getter(messagesBySessionAtom)[sessionId]
    if (!messages) return
    const plan = planSummaryCompression(messages, getConversationMemory(store, sessionId))
    if (!plan) return

    let result
    try {
      result = await modelAdapter.summarize({
        previousSummary: plan.baseSummary || undefined,
        messages: plan.windowMessages,
      })
    } catch (error) {
      // MS4: AbortError also returns silently (no cursor advance); a non-Abort
      // failure is the M2.5 degradation path — likewise no cursor advance.
      if (error instanceof DOMException && error.name === 'AbortError') return
      return
    }

    // M2.4 CAS (MS1): re-read; commit only if NEITHER the cursor NOR the summary
    // moved meanwhile — guards against a concurrent "summary changed, cursor
    // unchanged" overwrite too.
    const current = getConversationMemory(store, sessionId)
    if (current.summarizedUpTo !== plan.baseCursor) return
    if (current.summary !== plan.baseSummary) return

    // Ghost guard (RF8): setConversationMemory no-ops when the session was
    // deleted (checks sessionsAtom), so a delayed summarize never resurrects it.
    setConversationMemory(store, sessionId, {
      summary: result.summary,
      summarizedUpTo: plan.targetCursor,
    })
  } finally {
    flight.delete(sessionId)
  }
}
