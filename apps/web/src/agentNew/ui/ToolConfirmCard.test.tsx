import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { runAtom, confirmTool } from '@web-agent/core'
import { ToolConfirmCard } from './ToolConfirmCard'

// S4-B ToolConfirmCard：危险工具确认卡片。契约 U1 —— 只读 atom（runAtom）+ 调命令（confirmTool）。
// 命令整模块 mock，断言「按了什么就调了什么」，不触碰真正的 runtime / store writer。
vi.mock('@web-agent/core/runtime/commands', () => ({
  confirmTool: vi.fn(),
}))

describe('ToolConfirmCard', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('run 非 waiting_confirmation（或无 pendingToolConfirmation）→ 渲染为空', () => {
    const running = createStore()
    running.setter(runAtom, { runId: 'r', status: 'running' })
    const { container: c1 } = renderWithStore(<ToolConfirmCard />, { store: running })
    expect(c1.querySelector('.agentnew-confirm')).toBeNull()

    const waitingNoPayload = createStore()
    waitingNoPayload.setter(runAtom, { runId: 'r', status: 'waiting_confirmation' })
    const { container: c2 } = renderWithStore(<ToolConfirmCard />, { store: waitingNoPayload })
    expect(c2.querySelector('.agentnew-confirm')).toBeNull()
  })

  it('waiting_confirmation：渲染工具名 + 参数预览；「允许」调 confirmTool(true,false)、「拒绝」调 confirmTool(false)', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: 'c1', toolName: 'shell_macos', args: { command: 'rm -rf build' } },
    })

    renderWithStore(<ToolConfirmCard />, { store })

    // 工具名 + command 预览渲染出来。
    expect(screen.getByText('shell_macos')).toBeInTheDocument()
    expect(screen.getByText('rm -rf build')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenLastCalledWith(true, false)

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(confirmTool).toHaveBeenLastCalledWith(false)
  })

  it('勾选「本 session 一律允许」后点允许 → confirmTool(true,true)', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: 'c1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    })

    renderWithStore(<ToolConfirmCard />, { store })

    // write_file 预览取 path。
    expect(screen.getByText('a.txt')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenLastCalledWith(true, true)
  })

  it('MCP 工具不提供 session 一律允许，单次允许固定调用 confirmTool(true,false)', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_confirmation',
      pendingToolConfirmation: {
        callId: 'mcp-1',
        toolName: 'mcp__playwright__browser_navigate',
        args: { url: 'https://example.com' },
        risk: 'dangerous',
      },
    })

    renderWithStore(<ToolConfirmCard />, { store })

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText('本 session 一律允许该工具')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenLastCalledWith(true, false)
  })

  it('极高风险确认不提供一律允许，并显示拦截原因', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r-critical',
      status: 'waiting_confirmation',
      pendingToolConfirmation: {
        callId: 'c-critical',
        toolName: 'shell_macos',
        args: { command: 'rm -rf *' },
        risk: 'critical',
        reason: '检测到可能删除大范围文件的递归强制删除命令',
      },
    })
    renderWithStore(<ToolConfirmCard />, { store })

    expect(screen.getByText('极高风险操作')).toBeInTheDocument()
    expect(screen.getByText('检测到可能删除大范围文件的递归强制删除命令')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenCalledWith(true, false)
  })

  it('不可撤回的普通 rm 不提供一律允许', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r-rm',
      status: 'waiting_confirmation',
      pendingToolConfirmation: {
        callId: 'c-rm',
        toolName: 'shell_macos',
        args: { command: 'rm note.txt' },
        risk: 'dangerous',
        irreversible: true,
        reason: '命令行 rm 会永久删除文件，无法通过回退工具恢复',
      },
    })
    renderWithStore(<ToolConfirmCard />, { store })

    expect(screen.getByText('命令行 rm 会永久删除文件，无法通过回退工具恢复')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenCalledWith(true, false)
  })

  it('换一次确认（新 callId）→「一律允许」勾选复位，不泄漏到下一次确认（codex P2）', () => {
    const store = createStore()
    store.setter(runAtom, {
      runId: 'r',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: 'c1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    })

    renderWithStore(<ToolConfirmCard />, { store })

    // 第一次确认：勾选「一律允许」。
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toBeChecked()

    // 换成另一个危险工具的确认（新 callId）——卡片按 key 整块重挂，勾选必须复位。
    act(() => {
      store.setter(runAtom, {
        runId: 'r',
        status: 'waiting_confirmation',
        pendingToolConfirmation: { callId: 'c2', toolName: 'shell_macos', args: { command: 'ls' } },
      })
    })

    expect(screen.getByRole('checkbox')).not.toBeChecked()
    // 此时点「允许」必须是 confirmTool(true,false)——用户并没有为这次确认勾选一律允许。
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(confirmTool).toHaveBeenLastCalledWith(true, false)
  })
})
