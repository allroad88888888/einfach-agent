import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { runAtom } from '../state/sessionAtoms'
import { Composer } from './Composer'
import { sendMessage, stopRun } from '../runtime/commands'

// P-U4 Composer：右栏输入框。契约 U1 —— UI 只读 atom（runAtom）+ 调命令
// （sendMessage / stopRun）。这里把命令整模块 mock，断言「按了什么就调了什么」，
// 不触碰真正的 runtime / store setter。
vi.mock('../runtime/commands', () => ({
  sendMessage: vi.fn(),
  stopRun: vi.fn(),
}))

describe('Composer', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('输入并点「发送」：sendMessage 收到 trim 后的草稿，输入框随后清空', () => {
    renderWithStore(<Composer />, { store: createStore() })

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(sendMessage).toHaveBeenCalledWith('hi')
    expect(textarea.value).toBe('')
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

  it('全局 Esc → stopRun（U7 中断）', () => {
    renderWithStore(<Composer />, { store: createStore() })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(stopRun).toHaveBeenCalledTimes(1)
  })
})
