import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeMessagesAtom,
  activeRunAtom,
  activeSessionIdAtom,
  pendingQuestionAnswersAtom,
  setRunState,
} from '../agent/state/atoms'
import type { AskUserQuestionPayload } from '../agent/runtime/types'
import { renderWithStore } from '../test/renderWithStore'
import { AskUserQuestionCard } from './AskUserQuestionCard'

const question: AskUserQuestionPayload = {
  id: 'question-test',
  title: '需要确认',
  questions: [
    {
      id: 'execution_scope',
      text: '这次希望 agent 直接给方案，还是先拆成模块任务？',
      type: 'single-choice',
      options: ['直接给方案', '先拆模块', '只提关键风险'],
      required: true,
    },
    {
      id: 'extra_context',
      text: '还有必须遵守的边界吗？',
      type: 'text',
    },
    {
      id: 'focus_modules',
      text: '这次重点看哪些模块？',
      type: 'multi-choice',
      options: ['runtime', 'tools', 'skills', 'ui'],
      required: true,
    },
    {
      id: 'allow_assumptions',
      text: '信息不足时是否允许采用保守默认值？',
      type: 'confirm',
      required: true,
    },
  ],
}

function createQuestionStore() {
  const store = createStore()
  const sessionId = store.getter(activeSessionIdAtom)
  setRunState(store, sessionId, {
    id: 'run-test',
    sessionId,
    status: 'waiting_user',
    input: '随便优化一下',
    loadedSkills: ['web-chat-agent'],
    loadedTools: ['delegate_agent', 'skill_search', 'skill_read', 'ask_user_question', 'browser_action'],
    pendingQuestion: question,
  })
  return store
}

describe('AskUserQuestionCard', () => {
  it('renders nothing without a pending question', () => {
    renderWithStore(<AskUserQuestionCard />)

    expect(screen.queryByRole('heading', { name: '需要确认' })).not.toBeInTheDocument()
  })

  it('requires required answers and resumes the run after submit', async () => {
    const user = userEvent.setup()
    const store = createQuestionStore()
    renderWithStore(<AskUserQuestionCard />, { store })

    expect(screen.getByRole('heading', { name: '需要确认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '先拆模块' }))
    expect(store.getter(pendingQuestionAnswersAtom)).toMatchObject({
      execution_scope: '先拆模块',
    })
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'runtime' }))
    await user.click(screen.getByRole('button', { name: 'skills' }))
    expect(store.getter(pendingQuestionAnswersAtom)).toMatchObject({
      execution_scope: '先拆模块',
      focus_modules: ['runtime', 'skills'],
    })
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '是' }))
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()

    await user.type(screen.getByPlaceholderText('补充说明'), '保持纯浏览器运行')
    await user.click(screen.getByRole('button', { name: '继续' }))

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 5000,
    })

    expect(screen.queryByRole('heading', { name: '需要确认' })).not.toBeInTheDocument()
    expect(store.getter(activeMessagesAtom).some((message) => message.content.includes('保持纯浏览器运行'))).toBe(true)
    expect(store.getter(activeMessagesAtom).some((message) => message.content.includes('focus_modules: runtime, skills'))).toBe(true)
    expect(store.getter(activeMessagesAtom).some((message) => message.content.includes('allow_assumptions: true'))).toBe(true)
  })
})
