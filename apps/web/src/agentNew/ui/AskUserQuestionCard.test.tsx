import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen, act } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import {
  runAtom,
  pendingQuestionAnswersAtom,
  answerQuestion,
  resumeWithAnswers,
} from '@web-agent/core'
import { AskUserQuestionCard } from './AskUserQuestionCard'

// P8-d AskUserQuestionCard：暂停确认卡片。契约 U1 —— UI 只读 atom（runAtom /
// pendingQuestionAnswersAtom）+ 调命令（answerQuestion / resumeWithAnswers）。
// 这里把命令整模块 mock，断言「改了什么就调了什么」，不触碰真正的 runtime / store writer。
vi.mock('@web-agent/core/runtime/commands', () => ({
  answerQuestion: vi.fn(),
  resumeWithAnswers: vi.fn(),
}))

describe('AskUserQuestionCard', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('run 非 waiting_user（或无 pendingQuestion）→ 渲染为空', () => {
    const running = createStore()
    running.setter(runAtom, { runId: 'r', status: 'running' })
    const { container: c1 } = renderWithStore(<AskUserQuestionCard />, { store: running })
    expect(c1.querySelector('.agentnew-ask')).toBeNull()

    const waitingNoPayload = createStore()
    waitingNoPayload.setter(runAtom, { runId: 'r', status: 'waiting_user' })
    const { container: c2 } = renderWithStore(<AskUserQuestionCard />, { store: waitingNoPayload })
    expect(c2.querySelector('.agentnew-ask')).toBeNull()
  })

  it('按 decision surface 分流，Plan 问题不会在普通对话槽重复显示', () => {
    const store = createStore()
    const payload = {
      title: '选择实现方案',
      questions: [{ id: 'approach', text: '采用哪个方案？', type: 'text' }],
    }
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_user',
      pendingQuestion: payload,
      pendingUserDecision: {
        callId: 'ask-plan',
        payload,
        origin: { surface: 'plan', phase: 'drafting' },
      },
    })

    const conversation = renderWithStore(
      <AskUserQuestionCard surface="conversation" />,
      { store },
    )
    expect(conversation.container.querySelector('.agentnew-ask')).toBeNull()
    conversation.unmount()

    const plan = renderWithStore(<AskUserQuestionCard surface="plan" />, { agentStore: store })
    expect(plan.container.querySelector('.agentnew-ask.is-plan-embedded')).not.toBeNull()
    expect(screen.getByText('计划等待决策')).toBeInTheDocument()
  })

  it('waiting_user + text 必填题：渲染题面；未答时「继续」禁用；输入调 answerQuestion；答齐后可继续', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_user',
      pendingQuestion: {
        title: '请补充信息',
        questions: [{ id: 'q1', text: '你的邮箱？', type: 'text', required: true }],
      },
    })

    renderWithStore(<AskUserQuestionCard />, { agentStore: store })

    // 标题 + 题面文本渲染出来
    expect(screen.getByText('请补充信息')).toBeInTheDocument()
    expect(screen.getByText('你的邮箱？')).toBeInTheDocument()

    // 未答：继续禁用
    const submit = screen.getByRole('button', { name: '继续' })
    expect(submit).toBeDisabled()

    // 输入 → answerQuestion(qid, 值)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'a@b.com' } })
    expect(answerQuestion).toHaveBeenCalledWith('q1', 'a@b.com')

    // 把该题答案 set 进 atom（模拟命令已回填）→ 继续可点
    act(() => {
      store.setter(pendingQuestionAnswersAtom, { q1: 'a@b.com' })
    })
    expect(submit).not.toBeDisabled()

    // 点继续 → resumeWithAnswers
    fireEvent.click(submit)
    expect(resumeWithAnswers).toHaveBeenCalledTimes(1)
  })

  it('confirm 题：点「是」传 true、点「否」传 false', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_user',
      pendingQuestion: {
        questions: [{ id: 'ok', text: '要继续吗？', type: 'confirm' }],
      },
    })

    renderWithStore(<AskUserQuestionCard />, { agentStore: store })

    fireEvent.click(screen.getByRole('button', { name: '是' }))
    expect(answerQuestion).toHaveBeenLastCalledWith('ok', true)

    fireEvent.click(screen.getByRole('button', { name: '否' }))
    expect(answerQuestion).toHaveBeenLastCalledWith('ok', false)
  })

  it('single-choice 传选中 string；multi-choice toggle 传 string[]', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_user',
      pendingQuestion: {
        questions: [
          { id: 'sc', text: '选一个', type: 'single-choice', options: ['甲', '乙'] },
          { id: 'mc', text: '选多个', type: 'multi-choice', options: ['A', 'B'] },
        ],
      },
    })

    renderWithStore(<AskUserQuestionCard />, { agentStore: store })

    // 单选：点「甲」→ 传字符串
    fireEvent.click(screen.getByRole('button', { name: '甲' }))
    expect(answerQuestion).toHaveBeenLastCalledWith('sc', '甲')

    // 多选：当前答案空，点「A」→ 传 ['A']
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(answerQuestion).toHaveBeenLastCalledWith('mc', ['A'])

    // 预置 mc 已选 ['A']，再点「A」→ toggle 掉 → 传 []
    act(() => {
      store.setter(pendingQuestionAnswersAtom, { mc: ['A'] })
    })
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(answerQuestion).toHaveBeenLastCalledWith('mc', [])
  })
})
