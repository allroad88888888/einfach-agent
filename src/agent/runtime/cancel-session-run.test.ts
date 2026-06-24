import { createStore } from '@einfach/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeSessionIdAtom,
  createSession,
  deleteSession,
  messagesBySessionAtom,
  runsBySessionAtom,
  sessionsAtom,
  timelineBySessionAtom,
} from '../state/atoms'
import { cancelSessionRun, startAgentRun } from './loop'

// The UI deletes a session by calling cancelSessionRun() then deleteSession().
function removeSession(store: ReturnType<typeof createStore>, sessionId: string) {
  cancelSessionRun(store, sessionId)
  deleteSession(store, sessionId)
}

function assertNoGhost(store: ReturnType<typeof createStore>, sessionId: string) {
  expect(store.getter(sessionsAtom)[sessionId]).toBeUndefined()
  expect(store.getter(messagesBySessionAtom)[sessionId]).toBeUndefined()
  expect(store.getter(timelineBySessionAtom)[sessionId]).toBeUndefined()
  expect(store.getter(runsBySessionAtom)[sessionId]).toBeUndefined()
}

describe('RF2 deleting a session mid-run never leaves a ghost (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('deletes during the pre-model phase (tool loading) with no resurrection', async () => {
    const store = createStore()
    const target = store.getter(activeSessionIdAtom)
    createSession(store, '其它会话')
    store.setter(activeSessionIdAtom, target)

    startAgentRun(store, '做一个 web agent 的执行方案，包含lazy tools')
    expect(store.getter(runsBySessionAtom)[target]?.status).toBe('running')

    // Advance past the main-architect wait (180ms) into the tool-loading phase,
    // i.e. before the model turn runs.
    await vi.advanceTimersByTimeAsync(200)

    removeSession(store, target)
    assertNoGhost(store, target)

    // Drain every remaining timer; the aborted run must not write anything back.
    await vi.advanceTimersByTimeAsync(5000)
    assertNoGhost(store, target)
  })

  it('deletes deeper in the run (near the model turn) with no resurrection', async () => {
    const store = createStore()
    const target = store.getter(activeSessionIdAtom)
    createSession(store, '其它会话')
    store.setter(activeSessionIdAtom, target)

    startAgentRun(store, '做一个 web agent 的执行方案，包含lazy tools')
    expect(store.getter(runsBySessionAtom)[target]?.status).toBe('running')

    // Advance further (main + several tool loads + worker + deputy waits) so we
    // are at/around the model-turn window before deleting.
    await vi.advanceTimersByTimeAsync(900)

    removeSession(store, target)
    assertNoGhost(store, target)

    await vi.advanceTimersByTimeAsync(5000)
    assertNoGhost(store, target)
  })
})
