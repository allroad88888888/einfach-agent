import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '../state/rootStore'
import { newSession, selectSession, removeSession, renameSession } from '../runtime/commands'
import { SessionList } from './SessionList'

// P-U2 SessionList：左栏会话列表。契约 U1 —— UI 只读 atom（sessionsAtom /
// activeSessionIdAtom）+ 调命令（newSession / selectSession / removeSession /
// renameSession），绝不碰 store setter / writers。故 commands 整个 mock 掉，
// 只断言「点了什么 → 调了哪个命令」。
vi.mock('../runtime/commands', () => ({
  newSession: vi.fn(),
  selectSession: vi.fn(),
  removeSession: vi.fn(),
  renameSession: vi.fn(),
}))

function seed() {
  rootStore.setter(sessionsAtom, {
    s1: { id: 's1', title: '会话一', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 1, updatedAt: 1 },
    s2: { id: 's2', title: '会话二', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 2, updatedAt: 2 },
  })
  rootStore.setter(activeSessionIdAtom, 's1')
}

describe('SessionList (P-U2)', () => {
  afterEach(() => {
    resetRootStore()
    vi.clearAllMocks()
  })

  it('渲染所有会话标题', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    expect(screen.getByText('会话一')).toBeInTheDocument()
    expect(screen.getByText('会话二')).toBeInTheDocument()
  })

  it('点「新建对话」→ 调 newSession', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.click(screen.getByText('+ 新建对话'))
    expect(newSession).toHaveBeenCalledTimes(1)
  })

  it('点会话标题 → 以其 id 调 selectSession', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.click(screen.getByText('会话二'))
    expect(selectSession).toHaveBeenCalledWith('s2')
  })

  it('点删除按钮 → 以其 id 调 removeSession', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    const item = screen.getByText('会话二').closest('.agentnew-session-item') as HTMLElement
    fireEvent.click(within(item).getByLabelText('删除'))
    expect(removeSession).toHaveBeenCalledWith('s2')
  })

  it('当前 active 会话（s1）带 active class', () => {
    seed()
    const { container } = renderWithStore(<SessionList />, { store: rootStore })

    const active = container.querySelector('.agentnew-session-item.active')
    expect(active).not.toBeNull()
    expect(active).toHaveTextContent('会话一')
  })

  // —— TT4：双击行内改名 ————————————————————————————————————————————————
  it('双击标题 → 换渲染 input，初值为原 title', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.doubleClick(screen.getByText('会话一'))

    const input = screen.getByDisplayValue('会话一')
    expect(input).toBeInTheDocument()
    expect(input).toHaveClass('agentnew-session-rename-input')
  })

  it('改值 + Enter → 以新值调 renameSession 并退出编辑（随后 blur 不重复提交）', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.doubleClick(screen.getByText('会话一'))
    const input = screen.getByDisplayValue('会话一')
    fireEvent.change(input, { target: { value: '改名后' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameSession).toHaveBeenCalledWith('s1', '改名后')
    // 退出编辑：input 消失、回到按钮渲染（标题仍是 atom 里的旧值 —— commands 被 mock）。
    expect(screen.queryByDisplayValue('改名后')).toBeNull()
    expect(screen.getByText('会话一')).toBeInTheDocument()

    // Enter 提交后的 blur 不得再触发一次提交（只提交一次守卫）。
    fireEvent.blur(input)
    expect(renameSession).toHaveBeenCalledTimes(1)
  })

  it('Esc → 退出编辑且不调 renameSession（随后 blur 也不提交）', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.doubleClick(screen.getByText('会话一'))
    const input = screen.getByDisplayValue('会话一')
    fireEvent.change(input, { target: { value: '不该提交' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue('不该提交')).toBeNull()
    expect(screen.getByText('会话一')).toBeInTheDocument()

    fireEvent.blur(input)
    expect(renameSession).not.toHaveBeenCalled()
  })

  it('失焦（blur）→ 提交一次并退出编辑', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.doubleClick(screen.getByText('会话二'))
    const input = screen.getByDisplayValue('会话二')
    fireEvent.change(input, { target: { value: 'blur改名' } })
    fireEvent.blur(input)

    expect(renameSession).toHaveBeenCalledTimes(1)
    expect(renameSession).toHaveBeenCalledWith('s2', 'blur改名')
    expect(screen.queryByDisplayValue('blur改名')).toBeNull()
  })

  it('IME 组合中的 Enter（isComposing）→ 不提交不退出；组合结束后 Enter 才提交（codex P2）', () => {
    seed()
    renderWithStore(<SessionList />, { store: rootStore })

    fireEvent.doubleClick(screen.getByText('会话一'))
    const input = screen.getByDisplayValue('会话一')
    fireEvent.change(input, { target: { value: '拼音中' } })

    // 拼音选字的 Enter：isComposing=true —— 是给输入法的，不得当提交。
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('拼音中')).toBeInTheDocument() // 仍在编辑态

    // 组合结束后的真 Enter 才提交。
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledWith('s1', '拼音中')
  })
})
