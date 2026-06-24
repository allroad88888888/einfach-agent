import { createStore } from '@einfach/core'
import { waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  activeMessagesAtom,
  activeRunAtom,
  activeSessionIdAtom,
  activeTimelineAtom,
  composerDraftAtom,
  setPendingQuestionAnswer,
} from '../state/atoms'
import { continueAgentRunWithAnswers, startAgentRun, stopActiveRun } from './loop'

describe('agent runtime loop', () => {
  it('handles a greeting without pausing for AskUserQuestion', async () => {
    const store = createStore()

    startAgentRun(store, 'hi')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 5000,
    })

    const run = store.getter(activeRunAtom)
    const messages = store.getter(activeMessagesAtom)

    expect(run?.pendingQuestion).toBeUndefined()
    expect(messages.at(-1)?.content).toContain('Hi')
    expect(store.getter(activeTimelineAtom).some((event) => event.title === 'AskUserQuestion')).toBe(false)
  })

  it('runs a normal request through skills, lazy tools, workers, and streaming answer', async () => {
    const store = createStore()

    store.setter(composerDraftAtom, 'draft text')
    startAgentRun(store, '做一个 web agent 的执行方案，包含lazy tools')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 5000,
    })

    const run = store.getter(activeRunAtom)
    const messages = store.getter(activeMessagesAtom)
    const timeline = store.getter(activeTimelineAtom)

    expect(store.getter(composerDraftAtom)).toBe('')
    expect(run?.loadedSkills).toEqual(['tool-loading', 'web-chat-agent'])
    expect(run?.loadedTools).toEqual(['delegate_agent', 'skill_search', 'skill_read'])
    expect(messages.some((message) => message.role === 'user' && message.content.includes('web agent'))).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      streaming: false,
    })
    expect(messages.at(-1)?.content).toContain('Loaded skills: tool-loading, web-chat-agent')
    expect(timeline.map((event) => event.title)).toEqual([
      'MainArchitectAgent',
      'skill_read',
      'load delegate_agent',
      'load skill_search',
      'load skill_read',
      'skill-worker',
      'tool-worker',
      'clarifier-worker',
      'answer-worker',
      'DeputyArchitectAgent',
      'ModelAgentTurn',
    ])
  })

  it('continues model/tool turns until the model returns an assistant message', async () => {
    const store = createStore()

    startAgentRun(store, '跑一个连续工具 loop tools')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 7000,
    })

    const messages = store.getter(activeMessagesAtom)
    const timeline = store.getter(activeTimelineAtom)

    expect(timeline.filter((event) => event.title === 'ModelAgentTurn').map((event) => event.detail)).toEqual([
      'request skill_search: Need skill_search schema before searching skills.',
      'payload skill_search',
      'request skill_read: Need skill_read schema before reading the selected skill.',
      'payload skill_read',
      'mock assistant message',
    ])
    expect(timeline.map((event) => event.title)).toEqual(
      expect.arrayContaining(['call skill_search', 'call skill_read']),
    )
    expect(messages.at(-1)?.content).toContain('multi-turn complete')
    expect(messages.at(-1)?.content).toContain('web-chat-agent')
  })

  it('returns every result required by a batched schema-request turn', async () => {
    const store = createStore()

    startAgentRun(store, '跑一个批量 schema batch schema loop tools')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    const timeline = store.getter(activeTimelineAtom)
    const modelDetails = timeline.filter((event) => event.title === 'ModelAgentTurn').map((event) => event.detail)

    expect(modelDetails[0]).toBe(
      'request skill_search, skill_read: Need skill_search schema before searching skills. | Need skill_read schema before reading skills.',
    )
    expect(timeline.map((event) => event.title)).toEqual(
      expect.arrayContaining(['call skill_search', 'call skill_read']),
    )
    expect(store.getter(activeMessagesAtom).at(-1)?.content).toContain('multi-turn complete')
  })

  it('can pause on AskUserQuestion after several model/tool turns', async () => {
    const store = createStore()

    startAgentRun(store, '跑一个多轮后问我 delayed askuser')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('waiting_user'), {
      timeout: 8000,
    })

    const run = store.getter(activeRunAtom)
    const timeline = store.getter(activeTimelineAtom)

    expect(run?.pendingQuestion?.title).toBe('延迟确认')
    expect(run?.pendingQuestion?.questions.map((question) => question.id)).toEqual(['target_domain', 'planning_depth'])
    expect(run?.loadedTools).toEqual([
      'delegate_agent',
      'skill_search',
      'skill_read',
      'ask_user_question',
      'browser_action',
    ])
    expect(timeline.filter((event) => event.title === 'ModelAgentTurn').map((event) => event.detail)).toEqual([
      'request skill_search: Need skill_search schema before gathering context.',
      'payload skill_search',
      'request skill_read: Need skill_read schema before reading the selected context.',
      'payload skill_read',
      'request ask_user_question: Need ask_user_question schema after collecting context.',
      'payload ask_user_question: 2 question(s)',
    ])
    expect(timeline.map((event) => event.title)).toEqual(
      expect.arrayContaining(['call skill_search', 'call skill_read', 'load ask_user_question', 'load browser_action']),
    )

    setPendingQuestionAnswer(store, 'target_domain', 'TypeScript 类型系统')
    setPendingQuestionAnswer(store, 'planning_depth', '包含接口/数据库映射')
    continueAgentRunWithAnswers(store)

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    const timelineAfterResume = store.getter(activeTimelineAtom)
    const messagesAfterResume = store.getter(activeMessagesAtom)
    expect(timelineAfterResume.filter((event) => event.title === 'AskUserQuestion')).toHaveLength(1)
    expect(timelineAfterResume.some((event) => event.title === 'AskUserQuestion skipped')).toBe(true)
    expect(messagesAfterResume.at(-1)?.content).toContain('用户补充')
    expect(messagesAfterResume.at(-1)?.content).toContain('TypeScript 类型系统')
  })

  it('pauses on AskUserQuestion and resumes with answers', async () => {
    const store = createStore()

    startAgentRun(store, '随便优化一下')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('waiting_user'), {
      timeout: 5000,
    })

    expect(store.getter(activeRunAtom)?.pendingQuestion?.questions.map((question) => question.id)).toEqual([
      'execution_scope',
      'extra_context',
      'focus_modules',
      'allow_assumptions',
    ])
    expect(store.getter(activeRunAtom)?.loadedTools).toEqual([
      'delegate_agent',
      'skill_search',
      'skill_read',
      'ask_user_question',
      'browser_action',
    ])
    expect(store.getter(activeTimelineAtom).filter((event) => event.title === 'ModelAgentTurn').map((event) => event.detail)).toEqual([
      'request ask_user_question: The request is ambiguous and needs user decisions.',
      'payload ask_user_question: 4 question(s)',
    ])

    setPendingQuestionAnswer(store, 'execution_scope', '先拆模块')
    setPendingQuestionAnswer(store, 'extra_context', '保持纯浏览器运行')
    setPendingQuestionAnswer(store, 'focus_modules', ['runtime', 'skills'])
    setPendingQuestionAnswer(store, 'allow_assumptions', true)
    continueAgentRunWithAnswers(store)

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 5000,
    })

    const messages = store.getter(activeMessagesAtom)
    expect(messages.some((message) => message.content.includes('已补充'))).toBe(true)
    expect(messages.at(-1)?.content).toContain('用户补充')
    expect(messages.at(-1)?.content).toContain('保持纯浏览器运行')
    expect(messages.at(-1)?.content).toContain('focus_modules: runtime, skills')
    expect(messages.at(-1)?.content).toContain('allow_assumptions: true')
  })

  it('stops the active run and records a stopped timeline event', async () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    startAgentRun(store, '做一个 web agent 的执行方案，包含lazy tools')
    expect(store.getter(activeRunAtom)?.status).toBe('running')

    stopActiveRun(store)

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('stopped'), {
      timeout: 1000,
    })

    expect(store.getter(activeRunAtom)?.sessionId).toBe(sessionId)
    expect(store.getter(activeTimelineAtom).at(-1)).toMatchObject({
      title: 'Run stopped',
      status: 'stopped',
    })
  })
})
