import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen, act } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { runAtom } from '@web-agent/core/state/sessionAtoms'
import { pendingQuestionAnswersAtom } from '@web-agent/core/state/transientAtoms'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { answerQuestion, resumeWithAnswers } from '@web-agent/core/runtime/commands'

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

    renderWithStore(<AskUserQuestionCard />, { store })

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

    renderWithStore(<AskUserQuestionCard />, { store })

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

    renderWithStore(<AskUserQuestionCard />, { store })

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
