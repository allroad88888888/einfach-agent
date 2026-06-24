import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  createSession,
  deleteSession,
  messagesBySessionAtom,
  runsBySessionAtom,
  selectSession,
  sessionsAtom,
  setRunState,
  timelineBySessionAtom,
} from './atoms'
import type { AgentRunState } from '../runtime/types'

describe('createSession', () => {
  it('creates a new session, selects it, and seeds empty collections', () => {
    const store = createStore()
    const before = Object.keys(store.getter(sessionsAtom)).length

    const id = createSession(store)

    expect(Object.keys(store.getter(sessionsAtom))).toHaveLength(before + 1)
    expect(store.getter(activeSessionIdAtom)).toBe(id)
    expect(store.getter(activeSessionAtom)).toBeDefined()
    expect(store.getter(messagesBySessionAtom)[id]).toEqual([])
    expect(store.getter(timelineBySessionAtom)[id]).toEqual([])
  })
})

describe('selectSession', () => {
  it('switches the active session', () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    const id = createSession(store)

    selectSession(store, original)
    expect(store.getter(activeSessionIdAtom)).toBe(original)

    selectSession(store, id)
    expect(store.getter(activeSessionIdAtom)).toBe(id)
  })

  it('ignores selecting an unknown session id', () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    selectSession(store, 'does-not-exist')
    expect(store.getter(activeSessionIdAtom)).toBe(original)
  })
})

describe('deleteSession', () => {
  it('removes a non-active session and keeps active untouched', () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    const other = createSession(store)
    selectSession(store, original)

    deleteSession(store, other)

    expect(store.getter(sessionsAtom)[other]).toBeUndefined()
    expect(store.getter(activeSessionIdAtom)).toBe(original)
    expect(store.getter(messagesBySessionAtom)[other]).toBeUndefined()
  })

  it('switches to another session when the active one is deleted', () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    const other = createSession(store)
    selectSession(store, original)

    deleteSession(store, original)

    expect(store.getter(sessionsAtom)[original]).toBeUndefined()
    expect(store.getter(activeSessionIdAtom)).toBe(other)
    expect(store.getter(activeSessionAtom)).toBeDefined()
  })

  it('recreates a default session when the last one is deleted', () => {
    const store = createStore()
    const only = store.getter(activeSessionIdAtom)

    deleteSession(store, only)

    const sessions = store.getter(sessionsAtom)
    expect(Object.keys(sessions)).toHaveLength(1)
    const newId = store.getter(activeSessionIdAtom)
    expect(sessions[newId]).toBeDefined()
    expect(store.getter(activeSessionAtom)).toBeDefined()
    // activeSessionAtom must never resolve to undefined
    expect(store.getter(activeSessionAtom)).not.toBeUndefined()
  })

  it('deleting a running active session still leaves a valid active session', () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    const other = createSession(store)
    selectSession(store, original)
    const run: AgentRunState = {
      id: 'run-x',
      sessionId: original,
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    }
    setRunState(store, original, run)

    deleteSession(store, original)

    expect(store.getter(runsBySessionAtom)[original]).toBeUndefined()
    expect(store.getter(activeSessionIdAtom)).toBe(other)
    expect(store.getter(activeSessionAtom)).toBeDefined()
  })
})
