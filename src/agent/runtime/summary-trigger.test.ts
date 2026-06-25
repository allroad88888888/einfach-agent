import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { MockModelAdapter } from '../model/mock-adapter'
import {
  activeSessionIdAtom,
  conversationMemoryBySessionAtom,
  createSession,
  deleteSession,
  getConversationMemory,
  messagesBySessionAtom,
  setConversationMemory,
} from '../state/atoms'
import {
  RAW_WINDOW_TURNS,
  SUMMARY_TRIGGER_TURNS,
  planSummaryCompression,
  runSummaryCompression,
} from './summary-trigger'
import { buildConversationContext } from './conversation-context'
import type { ChatMessage } from './types'

let seq = 0
const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage => ({
  id: `m-${seq++}`,
  createdAt: seq,
  ...over,
})

// Build a session whose messages array is: welcome + `turns` completed
// [user, assistant] pairs. Returns the messages.
function buildMessages(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [msg({ role: 'assistant', content: 'Web Agent 已就绪。' })]
  for (let i = 0; i < turns; i += 1) {
    messages.push(msg({ role: 'user', content: `用户提问 ${i}` }))
    messages.push(msg({ role: 'assistant', content: `助手回答 ${i}` }))
  }
  return messages
}

function seedSession(store: ReturnType<typeof createStore>, messages: ChatMessage[]) {
  const sessionId = createSession(store, 'mem')
  store.setter(messagesBySessionAtom, (prev) => ({ ...prev, [sessionId]: messages }))
  return sessionId
}

describe('M2.2 planSummaryCompression — trigger + cursor', () => {
  it('does NOT compress below the trigger threshold', () => {
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS - 1)
    const plan = planSummaryCompression(messages, { summary: '', summarizedUpTo: 0 })
    expect(plan).toBeNull()
  })

  it('compresses at the threshold, preserving the last RAW_WINDOW_TURNS turns raw', () => {
    const turns = SUMMARY_TRIGGER_TURNS
    const messages = buildMessages(turns)
    const plan = planSummaryCompression(messages, { summary: '', summarizedUpTo: 0 })
    expect(plan).not.toBeNull()

    // welcome(1) + turns*2 messages; keep last RAW_WINDOW_TURNS*2 raw.
    const expectedTarget = messages.length - RAW_WINDOW_TURNS * 2
    expect(plan?.targetCursor).toBe(expectedTarget)
    expect(plan?.baseCursor).toBe(0)

    // the compression window must NOT contain the last RAW_WINDOW_TURNS turns.
    const windowContents = plan!.windowMessages.map((m) => m.content)
    for (let i = turns - RAW_WINDOW_TURNS; i < turns; i += 1) {
      expect(windowContents).not.toContain(`用户提问 ${i}`)
      expect(windowContents).not.toContain(`助手回答 ${i}`)
    }
    // it SHOULD contain the older turns.
    expect(windowContents).toContain('用户提问 0')
    expect(windowContents).toContain(`助手回答 ${turns - RAW_WINDOW_TURNS - 1}`)
  })

  it('counts only UNsummarized completed turns past the existing cursor', () => {
    // Already summarized up to after turn 0 (cursor = welcome + 2 = 3). Only
    // (TRIGGER-1) fresh turns remain → below threshold → no compression.
    const turns = SUMMARY_TRIGGER_TURNS
    const messages = buildMessages(turns)
    const cursor = 1 + 2 // welcome + first completed turn
    const plan = planSummaryCompression(messages, { summary: 'prev', summarizedUpTo: cursor })
    expect(plan).toBeNull()
  })

  it('passes the previous summary into the plan (incremental summarization)', () => {
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const plan = planSummaryCompression(messages, { summary: '旧摘要', summarizedUpTo: 0 })
    expect(plan?.baseSummary).toBe('旧摘要')
  })
})

describe('M2.4/M2.5 runSummaryCompression — CAS, single-flight, degradation, ghost', () => {
  it('commits the new summary and advances the cursor on success', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()

    await runSummaryCompression(store, sessionId, adapter)

    const mem = getConversationMemory(store, sessionId)
    expect(mem.summarizedUpTo).toBe(messages.length - RAW_WINDOW_TURNS * 2)
    expect(mem.summary).not.toBe('')
  })

  it('CAS: discards a stale result when the cursor moved while summarizing', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    // Make summarize slow so we can move the cursor mid-flight.
    adapter.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 30))

    const p = runSummaryCompression(store, sessionId, adapter)
    // Concurrent advance: another run already summarized further.
    setConversationMemory(store, sessionId, { summary: '更新的摘要', summarizedUpTo: 99 })
    await p

    const mem = getConversationMemory(store, sessionId)
    // stale task must NOT have overwritten the newer cursor/summary.
    expect(mem.summarizedUpTo).toBe(99)
    expect(mem.summary).toBe('更新的摘要')
  })

  it('single-flight: a second call while one is in flight is a no-op', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    const spy = vi.spyOn(adapter, 'summarize')
    adapter.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 25))

    const p1 = runSummaryCompression(store, sessionId, adapter)
    const p2 = runSummaryCompression(store, sessionId, adapter)
    await Promise.all([p1, p2])

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('degradation: a summarize failure does NOT advance the cursor or write summary', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    adapter.summarizeShouldFail = true

    await expect(runSummaryCompression(store, sessionId, adapter)).resolves.toBeUndefined()

    const mem = getConversationMemory(store, sessionId)
    expect(mem.summarizedUpTo).toBe(0)
    expect(mem.summary).toBe('')
  })

  it('ghost: a delayed summarize whose session was deleted does not resurrect it', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    adapter.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 30))

    const p = runSummaryCompression(store, sessionId, adapter)
    deleteSession(store, sessionId)
    await p

    expect(store.getter(conversationMemoryBySessionAtom)[sessionId]).toBeUndefined()
  })

  it('MS1 CAS: discards a stale result when the SUMMARY changed but the cursor did not', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    adapter.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 30))

    const p = runSummaryCompression(store, sessionId, adapter)
    // Concurrent: summary replaced but cursor kept at baseCursor (0).
    setConversationMemory(store, sessionId, { summary: '别人写的摘要', summarizedUpTo: 0 })
    await p

    const mem = getConversationMemory(store, sessionId)
    // stale task must NOT overwrite the concurrently-changed summary.
    expect(mem.summary).toBe('别人写的摘要')
    expect(mem.summarizedUpTo).toBe(0)
  })
})

describe('MS2 inFlight isolation per (store, session)', () => {
  it('two different stores with the same session id do not block each other', async () => {
    const storeA = createStore()
    const storeB = createStore()
    // Both use the SAME default session id (each fresh store seeds the same one).
    const sessionId = storeA.getter(activeSessionIdAtom)
    expect(storeB.getter(activeSessionIdAtom)).toBe(sessionId)

    const messagesA = buildMessages(SUMMARY_TRIGGER_TURNS)
    const messagesB = buildMessages(SUMMARY_TRIGGER_TURNS)
    storeA.setter(messagesBySessionAtom, (prev) => ({ ...prev, [sessionId]: messagesA }))
    storeB.setter(messagesBySessionAtom, (prev) => ({ ...prev, [sessionId]: messagesB }))

    const adapterA = new MockModelAdapter()
    const adapterB = new MockModelAdapter()
    adapterA.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 30))
    adapterB.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 30))
    const spyA = vi.spyOn(adapterA, 'summarize')
    const spyB = vi.spyOn(adapterB, 'summarize')

    // Run both concurrently — same session id, different stores.
    await Promise.all([
      runSummaryCompression(storeA, sessionId, adapterA),
      runSummaryCompression(storeB, sessionId, adapterB),
    ])

    // Neither blocked the other: both summarized and both committed.
    expect(spyA).toHaveBeenCalledTimes(1)
    expect(spyB).toHaveBeenCalledTimes(1)
    expect(getConversationMemory(storeA, sessionId).summary).not.toBe('')
    expect(getConversationMemory(storeB, sessionId).summary).not.toBe('')
  })
})

describe('MS3 table-driven cursor + raw-window invariant (with interleaved noise)', () => {
  // Build welcome + `turns` completed pairs, sprinkling ineligible noise
  // (system / scaffold / streaming / empty) between turns. Noise must not
  // affect the completed-turn count or the preserved raw window.
  function buildNoisyMessages(turns: number): ChatMessage[] {
    const out: ChatMessage[] = [msg({ role: 'assistant', content: 'Web Agent 已就绪。' })]
    for (let i = 0; i < turns; i += 1) {
      if (i % 2 === 0) out.push(msg({ role: 'system', content: '系统噪声' }))
      out.push(msg({ role: 'user', content: `Q${i}` }))
      if (i % 3 === 0) out.push(msg({ role: 'assistant', content: '占位', scaffold: 'ask-placeholder' }))
      out.push(msg({ role: 'assistant', content: `A${i}` }))
      if (i % 2 === 1) out.push(msg({ role: 'assistant', content: '半条', streaming: true }))
      if (i % 4 === 0) out.push(msg({ role: 'user', content: '   ' }))
    }
    return out
  }

  for (const turns of [6, 7, 12]) {
    it(`compresses ${turns} turns, always keeping the last ${RAW_WINDOW_TURNS} turns raw`, () => {
      const messages = buildNoisyMessages(turns)
      const plan = planSummaryCompression(messages, { summary: '', summarizedUpTo: 0 })
      expect(plan).not.toBeNull()

      // compression window = first (turns - RAW_WINDOW) completed turns.
      const compressCount = turns - RAW_WINDOW_TURNS
      expect(plan!.windowMessages).toHaveLength(compressCount * 2)

      const windowContents = plan!.windowMessages.map((m) => m.content)
      // the last RAW_WINDOW_TURNS turns must NOT be in the window.
      for (let i = turns - RAW_WINDOW_TURNS; i < turns; i += 1) {
        expect(windowContents).not.toContain(`Q${i}`)
        expect(windowContents).not.toContain(`A${i}`)
      }
      // older turns ARE in the window.
      expect(windowContents).toContain('Q0')
      expect(windowContents).toContain(`A${turns - RAW_WINDOW_TURNS - 1}`)

      // After applying the plan, buildConversationContext over the new cursor
      // must surface exactly the last RAW_WINDOW_TURNS turns as raw recentMessages.
      const ctx = buildConversationContext(
        messages,
        { summary: 'S', summarizedUpTo: plan!.targetCursor },
        messages.length,
      )
      expect(ctx.recentMessages).toHaveLength(RAW_WINDOW_TURNS * 2)
      const raw = JSON.stringify(ctx.recentMessages)
      expect(raw).toContain(`Q${turns - 1}`)
      expect(raw).toContain(`A${turns - RAW_WINDOW_TURNS}`)
      expect(raw).not.toContain(`Q${turns - RAW_WINDOW_TURNS - 1}`)
    })
  }

  it('MS3 degradation: after a summarize failure, the old un-summarized原文 is still injected', async () => {
    const store = createStore()
    const messages = buildMessages(SUMMARY_TRIGGER_TURNS)
    const sessionId = seedSession(store, messages)
    const adapter = new MockModelAdapter()
    adapter.summarizeShouldFail = true

    await runSummaryCompression(store, sessionId, adapter)

    // Cursor unchanged → buildConversationContext re-injects ALL completed turns.
    const ctx = buildConversationContext(
      messages,
      getConversationMemory(store, sessionId),
      messages.length,
    )
    expect(ctx.summary).toBe('')
    expect(ctx.recentMessages).toHaveLength(SUMMARY_TRIGGER_TURNS * 2)
    const raw = JSON.stringify(ctx.recentMessages)
    expect(raw).toContain('用户提问 0') // oldest turn still present as raw
    expect(raw).toContain(`用户提问 ${SUMMARY_TRIGGER_TURNS - 1}`)
  })
})
