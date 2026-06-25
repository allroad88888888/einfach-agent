import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeSessionIdAtom,
  conversationMemoryBySessionAtom,
  createSession,
  deleteSession,
  getConversationMemory,
  setConversationMemory,
} from './atoms'

const GONE = 'session-gone'

describe('M1.1 conversation memory atom + helpers', () => {
  it('returns a default { summary: "", summarizedUpTo: 0 } for a session with no memory yet', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    expect(getConversationMemory(store, sessionId)).toEqual({ summary: '', summarizedUpTo: 0 })
  })

  it('setConversationMemory writes for an existing session and is read back', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    setConversationMemory(store, sessionId, { summary: '摘要文本', summarizedUpTo: 4 })

    expect(getConversationMemory(store, sessionId)).toEqual({ summary: '摘要文本', summarizedUpTo: 4 })
    expect(store.getter(conversationMemoryBySessionAtom)[sessionId]).toEqual({
      summary: '摘要文本',
      summarizedUpTo: 4,
    })
  })

  it('ghost guard: setConversationMemory is a no-op for a non-existent session', () => {
    const store = createStore()

    setConversationMemory(store, GONE, { summary: 'x', summarizedUpTo: 2 })

    expect(store.getter(conversationMemoryBySessionAtom)[GONE]).toBeUndefined()
    // and reading still returns the default
    expect(getConversationMemory(store, GONE)).toEqual({ summary: '', summarizedUpTo: 0 })
  })

  it('deleteSession clears the conversation memory entry', () => {
    const store = createStore()
    const sessionId = createSession(store, 'Mem session')
    setConversationMemory(store, sessionId, { summary: 's', summarizedUpTo: 1 })
    expect(store.getter(conversationMemoryBySessionAtom)[sessionId]).toBeDefined()

    deleteSession(store, sessionId)

    expect(store.getter(conversationMemoryBySessionAtom)[sessionId]).toBeUndefined()
  })
})
