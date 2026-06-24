import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  appendMessage,
  appendTimelineEvent,
  messagesBySessionAtom,
  patchRunState,
  runsBySessionAtom,
  sessionsAtom,
  setRunState,
  setSessionStatus,
  timelineBySessionAtom,
  updateMessage,
  updateTimelineEvent,
} from './atoms'
import type { ChatMessage, TimelineEvent } from '../runtime/types'

const GONE = 'session-gone'

const message: ChatMessage = { id: 'm1', role: 'user', content: 'x', createdAt: 1 }
const event: TimelineEvent = {
  id: 'e1',
  runId: 'r1',
  kind: 'tool',
  title: 't',
  status: 'running',
  timestamp: 1,
}

describe('RF8 state write-back helpers no-op for a non-existent session', () => {
  it('appendMessage does not resurrect a deleted session', () => {
    const store = createStore()
    appendMessage(store, GONE, message)
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(messagesBySessionAtom)[GONE]).toBeUndefined()
  })

  it('updateMessage does not resurrect a deleted session', () => {
    const store = createStore()
    updateMessage(store, GONE, 'm1', { content: 'y' })
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(messagesBySessionAtom)[GONE]).toBeUndefined()
  })

  it('appendTimelineEvent does not resurrect a deleted session', () => {
    const store = createStore()
    appendTimelineEvent(store, GONE, event)
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(timelineBySessionAtom)[GONE]).toBeUndefined()
  })

  it('updateTimelineEvent does not resurrect a deleted session', () => {
    const store = createStore()
    updateTimelineEvent(store, GONE, 'e1', { status: 'done' })
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(timelineBySessionAtom)[GONE]).toBeUndefined()
  })

  it('setSessionStatus does not create a ghost session with missing fields', () => {
    const store = createStore()
    setSessionStatus(store, GONE, 'running')
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
  })

  it('setRunState does not resurrect a deleted session', () => {
    const store = createStore()
    setRunState(store, GONE, {
      id: 'r1',
      sessionId: GONE,
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    })
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(runsBySessionAtom)[GONE]).toBeUndefined()
  })

  it('patchRunState is a no-op when the session/run is gone', () => {
    const store = createStore()
    patchRunState(store, GONE, { status: 'stopped' })
    expect(store.getter(sessionsAtom)[GONE]).toBeUndefined()
    expect(store.getter(runsBySessionAtom)[GONE]).toBeUndefined()
  })

  it('still works normally for an existing session', () => {
    const store = createStore()
    const active = Object.keys(store.getter(sessionsAtom))[0]
    const messagesBefore = (store.getter(messagesBySessionAtom)[active] ?? []).length
    const timelineBefore = (store.getter(timelineBySessionAtom)[active] ?? []).length

    appendMessage(store, active, message)
    appendTimelineEvent(store, active, event)
    setRunState(store, active, {
      id: 'r1',
      sessionId: active,
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    })
    patchRunState(store, active, { status: 'done' })

    expect(store.getter(messagesBySessionAtom)[active]).toHaveLength(messagesBefore + 1)
    expect(store.getter(timelineBySessionAtom)[active]).toHaveLength(timelineBefore + 1)
    expect(store.getter(runsBySessionAtom)[active]?.status).toBe('done')
    expect(store.getter(sessionsAtom)[active]?.status).toBe('done')
  })
})
