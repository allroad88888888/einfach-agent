import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import {
  runAtom,
  composerDraftAtom,
  queuedUserMessagesAtom,
  withdrawnTurnNoticeAtom,
  continueInterruptedRun,
  sendMessage,
  setApprovalMode,
  stopRun,
} from '@web-agent/core'
import { Composer } from './Composer'

// P-U4 Composer：右栏输入框。契约 U1 —— UI 只读 atom（runAtom）+ 调命令
// （sendMessage / stopRun）。这里把命令整模块 mock，断言「按了什么就调了什么」，
// 不触碰真正的 runtime / store setter。
vi.mock('@web-agent/core/runtime/commands', () => ({
  continueInterruptedRun: vi.fn(),
  sendMessage: vi.fn(() => ({ accepted: true })),
  setApprovalMode: vi.fn(),
  stopRun: vi.fn(),
}))

describe('Composer', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('输入并点「发送」：sendMessage 收到 trim 后的草稿，输入框随后清空', () => {
    const store = createStore()
    renderWithStore(<Composer />, { store })

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(sendMessage).toHaveBeenCalledWith('hi')
    expect(textarea.value).toBe('')
    expect(store.getter(composerDraftAtom)).toBe('')
  })

  it('Enter（非 shift）发送；Shift+Enter 不发送', () => {
    renderWithStore(<Composer />, { store: createStore() })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'go' } })

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sendMessage).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMessage).toHaveBeenCalledWith('go')
  })

  it('输入框聚焦时按 Shift+Tab 切换模式，单次按压只触发一次', () => {
    const { rerender } = renderWithStore(<Composer approvalMode="confirm" />, { store: createStore() })
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true })
    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true, repeat: true })
    expect(setApprovalMode).toHaveBeenCalledTimes(1)
    expect(setApprovalMode).toHaveBeenLastCalledWith('auto')

    fireEvent.keyUp(textarea, { key: 'Tab', shiftKey: true })
    rerender(<Composer approvalMode="auto" />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab', shiftKey: true })
    expect(setApprovalMode).toHaveBeenLastCalledWith('confirm')
  })

  it('显示当前授权模式，点击也能切换', () => {
    renderWithStore(<Composer approvalMode="auto" />, { store: createStore() })

    expect(screen.getByText(/授权：Auto/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /授权模式：Auto/ }))
    expect(setApprovalMode).toHaveBeenCalledWith('confirm')
  })

  it('IME 组合输入中的 Enter 不发送；组合结束后 Enter 才发送', () => {
    renderWithStore(<Composer />, { store: createStore() })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'rust' } })

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMessage).not.toHaveBeenCalled()

    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMessage).toHaveBeenCalledWith('rust')
  })

  it('native isComposing / keyCode=229 的 Enter 不发送（IME 兼容）', () => {
    renderWithStore(<Composer />, { store: createStore() })

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '中文' } })

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('空草稿：发送按钮 disabled', () => {
    renderWithStore(<Composer />, { store: createStore() })

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('busy 态：仍可输入并加入队列，同时可单独停止', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'running' })
    renderWithStore(<Composer />, { store })

    const textarea = screen.getByRole('textbox')
    expect(textarea).not.toBeDisabled()
    fireEvent.change(textarea, { target: { value: '补充一下' } })
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }))
    expect(sendMessage).toHaveBeenCalledWith('补充一下')

    const stopBtn = screen.getByRole('button', { name: '停止' })
    fireEvent.click(stopBtn)

    expect(stopRun).toHaveBeenCalledTimes(1)
  })

  it('awaiting_tool 态：后台执行期间仍可加入队列和停止', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'awaiting_tool',
      pendingExecutionId: 'execution-1',
    })
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('textbox')).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '加入队列' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))

    expect(stopRun).toHaveBeenCalledTimes(1)
  })

  it('显示当前会话的排队消息数量', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'running' })
    store.setter(queuedUserMessagesAtom, [
      { id: 'q1', createdAt: 1, content: '第一条', targetRunId: 'r' },
      { id: 'q2', createdAt: 2, content: '第二条', targetRunId: 'r' },
    ])
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('status')).toHaveTextContent('已排队 2 条')
  })

  it('error 态：在输入区显示模型请求错误，并把 401 鉴权错误转换成可操作提示', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'error',
      error: 'Chat completion returned 401: Authentication Fails',
    })
    renderWithStore(<Composer />, { store })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('请求失败')
    expect(alert).toHaveTextContent('模型鉴权失败（401），请检查当前模型供应商的 API Key 是否有效。')
    expect(alert).toHaveTextContent('Chat completion returned 401: Authentication Fails')
    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  it('error 态：非鉴权错误直接显示原始错误信息', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'error', error: '模型返回空回复' })
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('alert')).toHaveTextContent('模型返回空回复')
  })

  it('输入框内 Esc：空闲时清空草稿，不触发 stopRun', () => {
    const store = createStore()
    renderWithStore(<Composer />, { store })

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'draft' } })
    expect(textarea.value).toBe('draft')

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(textarea.value).toBe('')
    expect(store.getter(composerDraftAtom)).toBe('')
    expect(stopRun).not.toHaveBeenCalled()
  })

  it('waiting_user 态：输入框 disabled、发送按钮 disabled、不出现停止按钮（codex P2）', () => {
    // 等 ask_user 回答时不能发新消息顶掉暂停中的 run（应走问题卡片的「继续」）。
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'waiting_user' })
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
    // 即便试图回车发送也不触发 sendMessage。
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('waiting_confirmation 态：输入框 disabled、发送按钮 disabled、不出现停止按钮（S4-B）', () => {
    // 等危险工具确认时不能发新消息顶掉暂停中的 run（应走确认卡片的「允许/拒绝」）。
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'waiting_confirmation' })
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('全局 Esc → stopRun（U7 中断）', () => {
    renderWithStore(<Composer />, { store: createStore() })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(stopRun).toHaveBeenCalledTimes(1)
  })

  it('interrupted 态：锁定普通输入并提供继续执行入口', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'interrupted', turnId: 'u1' })
    renderWithStore(<Composer />, { store })

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByText('应用重启中断了任务')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }))

    expect(continueInterruptedRun).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('撤回提示显示；再次输入后清除提示', () => {
    const store = createStore()
    store.setter(withdrawnTurnNoticeAtom, {
      id: 'n1',
      createdAt: 1,
      text: '已撤回本轮对话并放回输入框。',
      sideEffects: false,
    })
    renderWithStore(<Composer />, { store })

    expect(screen.getByText('已撤回本轮对话并放回输入框。')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edit' } })

    expect(store.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
    expect(screen.queryByText('已撤回本轮对话并放回输入框。')).toBeNull()
  })
})
