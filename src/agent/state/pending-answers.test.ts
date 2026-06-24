import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeSessionIdAtom,
  clearPendingQuestionAnswers,
  createSession,
  getPendingQuestionAnswers,
  pendingQuestionAnswersAtom,
  selectSession,
  setPendingQuestionAnswer,
} from './atoms'

describe('RF5 AskUser answers are scoped per session', () => {
  it('keeps two sessions answers independent', () => {
    const store = createStore()
    const sessionA = store.getter(activeSessionIdAtom)
    const sessionB = createSession(store, '会话 B')

    // Answer in session B (now active).
    setPendingQuestionAnswer(store, 'q1', 'B-answer')

    // Switch to A and answer there.
    selectSession(store, sessionA)
    setPendingQuestionAnswer(store, 'q1', 'A-answer')

    expect(getPendingQuestionAnswers(store)).toEqual({ q1: 'A-answer' })

    selectSession(store, sessionB)
    expect(getPendingQuestionAnswers(store)).toEqual({ q1: 'B-answer' })
  })

  it('pendingQuestionAnswersAtom reflects the active session (backward compatible flat shape)', () => {
    const store = createStore()
    setPendingQuestionAnswer(store, 'execution_scope', '先拆模块')
    setPendingQuestionAnswer(store, 'confirmed', true)

    // Existing assertion shape: flat Record for the active session.
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual({
      execution_scope: '先拆模块',
      confirmed: true,
    })
  })

  it('clearing one session does not wipe another session answers', () => {
    const store = createStore()
    const sessionA = store.getter(activeSessionIdAtom)
    const sessionB = createSession(store, '会话 B')

    setPendingQuestionAnswer(store, 'q1', 'B-answer')
    selectSession(store, sessionA)
    setPendingQuestionAnswer(store, 'q1', 'A-answer')

    // Clear A.
    clearPendingQuestionAnswers(store)
    expect(getPendingQuestionAnswers(store)).toEqual({})

    // B is untouched.
    selectSession(store, sessionB)
    expect(getPendingQuestionAnswers(store)).toEqual({ q1: 'B-answer' })
  })

  it('supports explicit sessionId override on set/get/clear', () => {
    const store = createStore()
    const sessionA = store.getter(activeSessionIdAtom)
    const sessionB = createSession(store, '会话 B') // active = B

    setPendingQuestionAnswer(store, 'q1', 'for-A', sessionA)
    // Active is B, but the answer landed in A.
    expect(getPendingQuestionAnswers(store, sessionA)).toEqual({ q1: 'for-A' })
    expect(getPendingQuestionAnswers(store, sessionB)).toEqual({})

    clearPendingQuestionAnswers(store, sessionA)
    expect(getPendingQuestionAnswers(store, sessionA)).toEqual({})
  })
})
