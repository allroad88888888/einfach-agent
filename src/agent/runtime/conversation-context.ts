import type { ConversationContext } from '../model'
import type { ConversationMemory } from '../state/atoms'
import type { ChatMessage, ChatRole } from './types'

/**
 * M1.3: assemble the conversation context injected into the model's first turn.
 *
 * Boundary (§0): `historyEndIndex` is the messages length captured in
 * `startAgentRun` *before* the current-run user was appended. Slicing
 * `[summarizedUpTo, historyEndIndex)` guarantees none of the current run's
 * messages (its user input, the AskUser "我需要先确认…" placeholder, the
 * "已补充:" user message, the streaming final assistant) ever enter history.
 *
 * MF3: when the boundary is unknown (`undefined` — e.g. a resumed run whose run
 * state predates this field), conservatively DISABLE memory rather than fall
 * back to the current messages length (which would塞 current-run / "已补充" msgs
 * into history). Returns no recentMessages and no summary in that case.
 *
 * Eligible filter (§0 / codex🟥8): drop ① the initial welcome — only an
 * assistant at absolute index 0 (MF1: a createSession session's first message is
 * the user, not a welcome, and must survive), ② role==='system', ③ streaming,
 * ④ empty content, ⑤ runtime scaffolding (MF7: identified by the `scaffold`
 * marker — AskUser placeholder / "已补充:" echo — never by content prefix).
 *
 * Completed-turn pairing (§0 / MF4): from the eligible messages keep only paired
 * `[user, completed assistant]` turns. Lone leftover users (stopped run) and
 * orphan assistants (incomplete run) are dropped — only fully completed turns
 * become prior history.
 *
 * In M1 `summarizedUpTo` is always 0 and `summary` always '', so this returns
 * the full set of completed prior turns as `recentMessages`.
 */
export function buildConversationContext(
  messages: ChatMessage[],
  memory: ConversationMemory,
  historyEndIndex: number | undefined,
): ConversationContext {
  // MF3: no trustworthy boundary → conservatively inject nothing.
  if (historyEndIndex === undefined) {
    return { summary: '', recentMessages: [] }
  }

  const start = Math.max(0, memory.summarizedUpTo)
  const end = Math.min(historyEndIndex, messages.length)

  const eligible = messages
    .slice(start, Math.max(start, end))
    .filter((message, offset) => {
      const absoluteIndex = start + offset
      // MF1: the initial welcome is ONLY an assistant at absolute index 0.
      if (absoluteIndex === 0 && message.role === 'assistant') return false
      if (message.role === 'system') return false
      if (message.streaming) return false
      if (!message.content.trim()) return false
      // MF4: runtime scaffolding is never real turn content.
      if (isRuntimeScaffolding(message)) return false
      return true
    })

  const recentMessages = pairCompletedTurns(eligible)

  return {
    summary: memory.summary,
    recentMessages,
  }
}

// MF7: runtime scaffolding (AskUser placeholder / "已补充:" echo) is identified
// by its structural marker only — NEVER by content prefix. A real user message
// beginning with "已补充：" or a real assistant answer beginning with
// "我需要先确认" carries no marker and must survive as genuine history.
function isRuntimeScaffolding(message: ChatMessage): boolean {
  return message.scaffold !== undefined
}

/**
 * MF4: greedily pair `[user, assistant]` into completed turns. A pending user is
 * closed by the next assistant; a second consecutive user means the first was an
 * unpaired leftover (stopped run) and is dropped; an assistant with no pending
 * user is an orphan and dropped; a trailing unpaired user is dropped.
 */
function pairCompletedTurns(
  eligible: ChatMessage[],
): { role: ChatRole; content: string }[] {
  const turns: { role: ChatRole; content: string }[] = []
  let pendingUser: ChatMessage | undefined

  for (const message of eligible) {
    if (message.role === 'user') {
      // A previous pending user without an assistant is an incomplete leftover.
      pendingUser = message
      continue
    }
    if (message.role === 'assistant' && pendingUser) {
      turns.push({ role: 'user', content: pendingUser.content })
      turns.push({ role: 'assistant', content: message.content })
      pendingUser = undefined
    }
    // assistant with no pending user → orphan, dropped.
  }

  return turns
}
