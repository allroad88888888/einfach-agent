import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeMessagesAtom,
  activeRunAtom,
  activeSessionIdAtom,
  activeTimelineAtom,
  appendMessage,
  appendTimelineEvent,
  canStopAtom,
  clearPendingQuestionAnswers,
  getPendingQuestionAnswers,
  patchRunState,
  pendingQuestionAnswersAtom,
  setPendingQuestionAnswer,
  setRunState,
  updateMessage,
  updateTimelineEvent,
} from './atoms'
import type { AgentRunState, ChatMessage, TimelineEvent } from '../runtime/types'

describe('Einfach state helpers', () => {
  it('appends and updates messages without mutating the previous array', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    const before = store.getter(activeMessagesAtom)

    const message: ChatMessage = {
      id: 'msg-test',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    }

    appendMessage(store, sessionId, message)
    expect(store.getter(activeMessagesAtom)).toHaveLength(before.length + 1)
    expect(store.getter(activeMessagesAtom)).not.toBe(before)

    updateMessage(store, sessionId, 'msg-test', { content: 'updated' })
    expect(store.getter(activeMessagesAtom).at(-1)?.content).toBe('updated')
  })

  it('appends and updates timeline events', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    const event: TimelineEvent = {
      id: 'event-test',
      runId: 'run-test',
      kind: 'tool',
      title: 'load tool',
      status: 'running',
      timestamp: 1,
    }

    appendTimelineEvent(store, sessionId, event)
    expect(store.getter(activeTimelineAtom)).toEqual([event])

    updateTimelineEvent(store, sessionId, 'event-test', {
      detail: 'loaded',
      status: 'done',
    })
    expect(store.getter(activeTimelineAtom)[0]).toMatchObject({
      detail: 'loaded',
      status: 'done',
    })
  })

  it('keeps session status derived from active run status', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    const run: AgentRunState = {
      id: 'run-test',
      sessionId,
      status: 'running',
      input: 'hello',
      loadedSkills: [],
      loadedTools: [],
    }

    setRunState(store, sessionId, run)
    expect(store.getter(activeRunAtom)?.status).toBe('running')
    expect(store.getter(canStopAtom)).toBe(true)

    patchRunState(store, sessionId, { status: 'done', loadedTools: ['delegate_agent'] })
    expect(store.getter(activeRunAtom)).toMatchObject({
      status: 'done',
      loadedTools: ['delegate_agent'],
    })
    expect(store.getter(canStopAtom)).toBe(false)
  })

  it('stores and clears pending AskUserQuestion answers', () => {
    const store = createStore()

    setPendingQuestionAnswer(store, 'execution_scope', '先拆模块')
    setPendingQuestionAnswer(store, 'confirmed', true)
    expect(getPendingQuestionAnswers(store)).toEqual({
      execution_scope: '先拆模块',
      confirmed: true,
    })

    clearPendingQuestionAnswers(store)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual({})
  })
})
