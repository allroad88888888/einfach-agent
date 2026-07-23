import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { runAtom } from '@web-agent/core/state/sessionAtoms'
import { composerDraftAtom, withdrawnTurnNoticeAtom } from '@web-agent/core/state/transientAtoms'
import { Composer } from './Composer'
import { sendMessage, stopRun, withdrawCurrentTurnToDraft } from '@web-agent/core/runtime/commands'

// P-U4 Composer：右栏输入框。契约 U1 —— UI 只读 atom（runAtom）+ 调命令
// （sendMessage / stopRun）。这里把命令整模块 mock，断言「按了什么就调了什么」，
// 不触碰真正的 runtime / store setter。
vi.mock('@web-agent/core/runtime/commands', () => ({
  sendMessage: vi.fn(),
  stopRun: vi.fn(),
  withdrawCurrentTurnToDraft: vi.fn(),
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

  it('busy 态：按钮变「停止」，点击调 stopRun，输入框 disabled', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'running' })
    renderWithStore(<Composer />, { store })

    const stopBtn = screen.getByRole('button', { name: '停止' })
    fireEvent.click(stopBtn)

    expect(stopRun).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toBeDisabled()
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

  it('stopped 态：显示撤回并编辑入口，点击调用 withdrawCurrentTurnToDraft', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r', status: 'stopped' })
    renderWithStore(<Composer />, { store })

    expect(screen.getByText('已停止')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '撤回并编辑' }))

    expect(withdrawCurrentTurnToDraft).toHaveBeenCalledTimes(1)
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
