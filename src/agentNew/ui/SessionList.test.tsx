import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '../state/rootStore'
import { newSession, selectSession, removeSession } from '../runtime/commands'
import { SessionList } from './SessionList'

// P-U2 SessionList：左栏会话列表。契约 U1 —— UI 只读 atom（sessionsAtom /
// activeSessionIdAtom）+ 调命令（newSession / selectSession / removeSession），绝不碰
// store setter / writers。故 commands 整个 mock 掉，只断言「点了什么 → 调了哪个命令」。
vi.mock('../runtime/commands', () => ({
  newSession: vi.fn(),
  selectSession: vi.fn(),
  removeSession: vi.fn(),
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
})
