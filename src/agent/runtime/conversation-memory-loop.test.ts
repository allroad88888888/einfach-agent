import { createStore } from '@einfach/core'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockModelAdapter } from '../model/mock-adapter'
import { activeMessagesAtom, activeRunAtom } from '../state/atoms'
import { startAgentRun } from './loop'
import type { AgentTurnInput } from '../model'

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
