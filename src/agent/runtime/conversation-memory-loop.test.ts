import { createStore } from '@einfach/core'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockModelAdapter } from '../model/mock-adapter'
import {
  activeMessagesAtom,
  activeRunAtom,
  activeSessionIdAtom,
  conversationMemoryBySessionAtom,
  getConversationMemory,
  messagesBySessionAtom,
} from '../state/atoms'
import { startAgentRun } from './loop'
import { RAW_WINDOW_TURNS, SUMMARY_TRIGGER_TURNS } from './summary-trigger'
import type { AgentTurnInput } from '../model'
import type { ChatMessage } from './types'

// Capture every conversationContext the loop hands to the model so we can assert
// the run boundary + eligible filtering end-to-end.
const seenContexts: Array<AgentTurnInput['conversationContext']> = []

vi.mock('../model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model')>()
  return {
    ...actual,
    createModelAdapter: () => {
      const adapter = new MockModelAdapter()
      const original = adapter.runAgentTurn.bind(adapter)
      adapter.runAgentTurn = (input) => {
        seenContexts.push(input.conversationContext)
        return original(input)
      }
      return adapter
    },
  }
})

beforeEach(() => {
  seenContexts.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('M1.3 loop injects prior-turn history but never the current run messages', () => {
  it('second run sees the first turn as recentMessages, not its own user input', async () => {
    const store = createStore()

    // First run (greeting → resolves immediately, no AskUser pause).
    startAgentRun(store, 'hi')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 5000 })

    seenContexts.length = 0

    // Second run.
    startAgentRun(store, '第二个问题')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 5000 })

    expect(seenContexts.length).toBeGreaterThan(0)
    const ctx = seenContexts[0]
    expect(ctx).toBeDefined()
    const serialized = JSON.stringify(ctx?.recentMessages ?? [])

    // The first turn's user + assistant are present...
    expect(serialized).toContain('hi')
    // ...but the second run's own user input is NOT in history.
    expect(serialized).not.toContain('第二个问题')
    // welcome (first assistant) excluded.
    expect(serialized).not.toContain('Web Agent 已就绪')
    // M1: summary stays empty.
    expect(ctx?.summary ?? '').toBe('')

    const messages = store.getter(activeMessagesAtom)
    expect(messages.some((m) => m.role === 'user' && m.content === '第二个问题')).toBe(true)
  })

  it('MF2: a multi-turn tool loop only injects conversationContext into the FIRST model turn', async () => {
    const store = createStore()

    // A multi-turn mock tool loop (request schema → payload → … → assistant)
    // produces several model turns; some carry no continuation.
    startAgentRun(store, '跑一个连续工具 loop tools')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 8000 })

    // More than one model turn ran.
    expect(seenContexts.length).toBeGreaterThan(1)
    // First turn carries the context...
    expect(seenContexts[0]).toBeDefined()
    // ...every subsequent turn carries none (no duplicate history injection).
    expect(seenContexts.slice(1).every((ctx) => ctx === undefined)).toBe(true)
  })

  it('MF6: a resend while a run is in flight does not let the aborted old run clobber the new run', async () => {
    const store = createStore()

    // Start a long multi-turn run, then — while it is mid-flight — resend a fast
    // greeting (start-while-running). The first run is aborted; its late
    // AbortError write-back (patchRunState → 'stopped') must NOT stomp the new
    // run, which is already 'running'/'done'.
    startAgentRun(store, '跑一个连续工具 loop tools')
    const firstRunId = store.getter(activeRunAtom)?.id

    // Let the first run get past its first awaits so an abort lands mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 250))

    startAgentRun(store, 'hi')
    const secondRunId = store.getter(activeRunAtom)?.id
    expect(secondRunId).not.toBe(firstRunId)

    // Track every status the SECOND run is ever observed in. The aborted first
    // run must never drive the new run into 'stopped'/'error'.
    const secondRunStatuses: string[] = []
    const unsub = store.sub(activeRunAtom, () => {
      const r = store.getter(activeRunAtom)
      if (r && r.id === secondRunId && r.status) secondRunStatuses.push(r.status)
    })

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 8000 })

    // Give the aborted first run ample time to fire any late write-back.
    await new Promise((resolve) => setTimeout(resolve, 300))
    unsub()

    const run = store.getter(activeRunAtom)
    // The surviving run is the second one and it stays 'done' — the aborted first
    // run never overwrote it to 'stopped'/'error'.
    expect(run?.id).toBe(secondRunId)
    expect(run?.status).toBe('done')
    expect(secondRunStatuses).not.toContain('stopped')
    expect(secondRunStatuses).not.toContain('error')
  })
})

describe('M2 summarize fires after a run reaches done', () => {
  let idSeq = 0
  const m = (role: ChatMessage['role'], content: string): ChatMessage => ({
    id: `seed-${idSeq++}`,
    role,
    content,
    createdAt: idSeq,
  })

  it('compresses old turns and the next run injects summary + the raw RAW_WINDOW', async () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    // Pre-seed welcome + SUMMARY_TRIGGER_TURNS completed turns so the trigger
    // fires on the next done.
    const seeded: ChatMessage[] = [m('assistant', 'Web Agent 已就绪。')]
    for (let i = 0; i < SUMMARY_TRIGGER_TURNS; i += 1) {
      seeded.push(m('user', `历史提问 ${i}`))
      seeded.push(m('assistant', `历史回答 ${i}`))
    }
    store.setter(messagesBySessionAtom, (prev) => ({ ...prev, [sessionId]: seeded }))

    seenContexts.length = 0
    startAgentRun(store, 'hi')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 5000 })

    // The async summarize is fire-and-forget — wait for the memory to update.
    await waitFor(() => expect(getConversationMemory(store, sessionId).summary).not.toBe(''), {
      timeout: 5000,
    })

    const mem = getConversationMemory(store, sessionId)
    expect(mem.summarizedUpTo).toBeGreaterThan(0)

    // A subsequent run injects the summary + the preserved raw window.
    seenContexts.length = 0
    startAgentRun(store, '下一句')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), { timeout: 5000 })

    const ctx = seenContexts[0]
    expect(ctx?.summary).toBe(mem.summary)
    // exactly the last RAW_WINDOW_TURNS turns survive as raw recentMessages.
    expect(ctx?.recentMessages.length).toBe(RAW_WINDOW_TURNS * 2)
    const serialized = JSON.stringify(ctx?.recentMessages ?? [])
    expect(serialized).toContain(`历史提问 ${SUMMARY_TRIGGER_TURNS - 1}`)
    expect(serialized).not.toContain('历史提问 0') // old turn now lives only in the summary
  })

  it('does not summarize for a non-done outcome (waiting_user)', async () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    const seeded: ChatMessage[] = [m('assistant', 'Web Agent 已就绪。')]
    for (let i = 0; i < SUMMARY_TRIGGER_TURNS; i += 1) {
      seeded.push(m('user', `历史提问 ${i}`))
      seeded.push(m('assistant', `历史回答 ${i}`))
    }
    store.setter(messagesBySessionAtom, (prev) => ({ ...prev, [sessionId]: seeded }))

    // '随便优化一下' pauses on AskUserQuestion (waiting_user), never done.
    startAgentRun(store, '随便优化一下')
    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('waiting_user'), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(store.getter(conversationMemoryBySessionAtom)[sessionId]?.summary ?? '').toBe('')
  })
})
