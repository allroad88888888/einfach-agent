import type { ConversationContext } from '../model'
import type { ConversationMemory } from '../state/atoms'
import type { ChatMessage } from './types'

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
  const turns = collectCompletedTurns(messages, start, end)

  const recentMessages = turns.flatMap((turn) => [
    { role: 'user' as const, content: turn.user.content },
    { role: 'assistant' as const, content: turn.assistant.content },
  ])

  return {
    summary: memory.summary,
    recentMessages,
  }
}

/**
 * A completed `[user, assistant]` turn carrying the original message indices so
 * the M2 compressor can map turns back to a message-index cursor.
 */
export interface CompletedTurn {
  user: { index: number; content: string }
  assistant: { index: number; content: string }
}

/**
 * Shared eligible-filter (§0/MF1/MF4/MF7) + completed-turn pairing (§0/MF4) over
 * `messages[start, end)`. Drops the welcome (assistant@index 0 only), system,
 * streaming, empty and scaffold-marked messages, then greedily pairs
 * `[user, assistant]`. Lone leftover users / orphan assistants are dropped.
 * Returns turns with their absolute message indices.
 */
export function collectCompletedTurns(
  messages: ChatMessage[],
  start: number,
  end: number,
): CompletedTurn[] {
  const turns: CompletedTurn[] = []
  let pending: { index: number; content: string } | undefined
  const clampedStart = Math.max(0, start)
  const clampedEnd = Math.min(end, messages.length)

  for (let index = clampedStart; index < clampedEnd; index += 1) {
    const message = messages[index]
    // MF1: the initial welcome is ONLY an assistant at absolute index 0.
    if (index === 0 && message.role === 'assistant') continue
    if (message.role === 'system') continue
    if (message.streaming) continue
    if (!message.content.trim()) continue
    // MF4/MF7: runtime scaffolding is never real turn content.
    if (isRuntimeScaffolding(message)) continue

    if (message.role === 'user') {
      // A previous pending user without an assistant is an incomplete leftover.
      pending = { index, content: message.content }
      continue
    }
    if (message.role === 'assistant' && pending) {
      turns.push({ user: pending, assistant: { index, content: message.content } })
      pending = undefined
    }
    // assistant with no pending user → orphan, dropped.
  }

  return turns
}

// MF7: runtime scaffolding (AskUser placeholder / "已补充:" echo) is identified
// by its structural marker only — NEVER by content prefix. A real user message
// beginning with "已补充：" or a real assistant answer beginning with
// "我需要先确认" carries no marker and must survive as genuine history.
function isRuntimeScaffolding(message: ChatMessage): boolean {
  return message.scaffold !== undefined
}
