import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import {
  rootStore,
  sessionsAtom,
  activeSessionIdAtom,
  selectSession,
  removeSession,
  renameSession,
} from '@einfach-agent/core'
import { SessionList } from './SessionList'

// P-U2 SessionList：左栏会话列表。契约 U1 —— UI 只读 atom（sessionsAtom /
// activeSessionIdAtom）+ 调命令（selectSession / removeSession / renameSession），
// 绝不碰 store setter / writers。故 commands 整个 mock 掉，
// 只断言「点了什么 → 调了哪个命令」。
vi.mock('@einfach-agent/core/runtime/commands', () => ({
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
    vi.clearAllMocks()
  })

  it('渲染所有会话标题', () => {
    seed()
    renderWithStore(<SessionList />)

    expect(screen.getByText('会话一')).toBeInTheDocument()
    expect(screen.getByText('会话二')).toBeInTheDocument()
  })

  it('点会话标题 → 以其 id 调 selectSession', () => {
    seed()
    renderWithStore(<SessionList />)

    fireEvent.click(screen.getByText('会话二'))
    expect(selectSession).toHaveBeenCalledWith('s2')
  })

  it('删除按钮两步确认后 → 以其 id 调 removeSession（TU2 起单击不再直删）', () => {
    seed()
    renderWithStore(<SessionList />)

    const item = screen.getByText('会话二').closest('.agentnew-session-item') as HTMLElement
    fireEvent.click(within(item).getByLabelText('删除'))
    fireEvent.click(within(item).getByLabelText('确认删除'))
    expect(removeSession).toHaveBeenCalledWith('s2')
  })

  it('当前 active 会话（s1）带 active class', () => {
    seed()
    const { container } = renderWithStore(<SessionList />)

    const active = container.querySelector('.agentnew-session-item.active')
    expect(active).not.toBeNull()
    expect(active).toHaveTextContent('会话一')
  })

  // —— TT4：双击行内改名 ————————————————————————————————————————————————
  it('双击标题 → 换渲染 input，初值为原 title', () => {
    seed()
    renderWithStore(<SessionList />)

    fireEvent.doubleClick(screen.getByText('会话一'))

    const input = screen.getByDisplayValue('会话一')
    expect(input).toBeInTheDocument()
    expect(input).toHaveClass('agentnew-session-rename-input')
  })

  it('改值 + Enter → 以新值调 renameSession 并退出编辑（随后 blur 不重复提交）', () => {
    seed()
    renderWithStore(<SessionList />)

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
    renderWithStore(<SessionList />)

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
    renderWithStore(<SessionList />)

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
    renderWithStore(<SessionList />)

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

  // —— TU1：列表按活跃（updatedAt）倒序 ————————————————————————————————
  /** 三个会话：createdAt A<B<C，updatedAt C<A<B —— 排序只该看 updatedAt。 */
  function seedForOrdering() {
    rootStore.setter(sessionsAtom, {
      sa: { id: 'sa', title: '会话A', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 1, updatedAt: 50 },
      sb: { id: 'sb', title: '会话B', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 2, updatedAt: 90 },
      sc: { id: 'sc', title: '会话C', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 3, updatedAt: 20 },
    })
    rootStore.setter(activeSessionIdAtom, 'sa')
  }

  /** 读列表当前渲染顺序（标题文本序列）。 */
  function titlesInOrder(container: HTMLElement) {
    return Array.from(container.querySelectorAll('.agentnew-session-title')).map(
      (el) => el.textContent,
    )
  }

  it('按 updatedAt 倒序渲染（createdAt 顺序不作数）', () => {
    seedForOrdering()
    const { container } = renderWithStore(<SessionList />)

    expect(titlesInOrder(container)).toEqual(['会话B', '会话A', '会话C'])
  })

  it('updatedAt 并列时退 createdAt 倒序', () => {
    rootStore.setter(sessionsAtom, {
      sa: { id: 'sa', title: '会话A', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 1, updatedAt: 50 },
      sb: { id: 'sb', title: '会话B', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 2, updatedAt: 50 },
    })
    rootStore.setter(activeSessionIdAtom, 'sa')
    const { container } = renderWithStore(<SessionList />)

    expect(titlesInOrder(container)).toEqual(['会话B', '会话A'])
  })

  // —— TU2：删除两步确认 ————————————————————————————————————————————————
  /** 取某标题所在行的行容器。 */
  function rowOf(title: string) {
    return screen.getByText(title).closest('.agentnew-session-item') as HTMLElement
  }

  it('首击 × → 不删，按钮进入确认态（aria-label「确认删除」+ .confirming）', () => {
    seed()
    renderWithStore(<SessionList />)

    const item = rowOf('会话二')
    fireEvent.click(within(item).getByLabelText('删除'))

    expect(removeSession).not.toHaveBeenCalled()
    const confirming = within(item).getByLabelText('确认删除')
    expect(confirming).toHaveClass('confirming')
  })

  it('确认态再击 → 以其 id 调 removeSession 一次', () => {
    seed()
    renderWithStore(<SessionList />)

    const item = rowOf('会话二')
    fireEvent.click(within(item).getByLabelText('删除'))
    fireEvent.click(within(item).getByLabelText('确认删除'))

    expect(removeSession).toHaveBeenCalledTimes(1)
    expect(removeSession).toHaveBeenCalledWith('s2')
  })

  it('确认态下鼠标移出该行 → 复位；此后再点只是重新进入确认态、不删', () => {
    seed()
    renderWithStore(<SessionList />)

    const item = rowOf('会话二')
    fireEvent.click(within(item).getByLabelText('删除'))
    fireEvent.mouseLeave(item)

    // 复位：aria-label 回「删除」。
    expect(within(item).getByLabelText('删除')).toBeInTheDocument()
    expect(within(item).queryByLabelText('确认删除')).toBeNull()

    // 复位后再点：只是重新进入确认态，仍不删。
    fireEvent.click(within(item).getByLabelText('删除'))
    expect(removeSession).not.toHaveBeenCalled()
    expect(within(item).getByLabelText('确认删除')).toBeInTheDocument()
  })

  it('确认态 3s 超时 → 自动复位、不删', () => {
    vi.useFakeTimers()
    try {
      seed()
      renderWithStore(<SessionList />)

      const item = rowOf('会话二')
      fireEvent.click(within(item).getByLabelText('删除'))
      expect(within(item).getByLabelText('确认删除')).toBeInTheDocument()

      // 定时器回调里 setState —— 包 act 走 React 更新。
      act(() => {
        vi.advanceTimersByTime(3000)
      })

      expect(within(item).getByLabelText('删除')).toBeInTheDocument()
      expect(within(item).queryByLabelText('确认删除')).toBeNull()
      expect(removeSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('切到另一行确认态 → 旧行复位且旧定时器被清（不误复位新行）', () => {
    vi.useFakeTimers()
    try {
      seed()
      renderWithStore(<SessionList />)

      const item1 = rowOf('会话一')
      const item2 = rowOf('会话二')

      // t=0：行一进入确认态；t=1500：切到行二。
      fireEvent.click(within(item1).getByLabelText('删除'))
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      fireEvent.click(within(item2).getByLabelText('删除'))

      // 同一时刻至多一行确认态：行一复位、行二确认中。
      expect(within(item1).getByLabelText('删除')).toBeInTheDocument()
      expect(within(item2).getByLabelText('确认删除')).toBeInTheDocument()

      // 再走 1600ms（越过行一旧定时器的 3000ms 时刻）：行二不得被旧定时器误复位。
      act(() => {
        vi.advanceTimersByTime(1600)
      })
      expect(within(item2).getByLabelText('确认删除')).toBeInTheDocument()

      // 行二自己的 3s 到点（t=1500+3000）才复位。
      act(() => {
        vi.advanceTimersByTime(1400)
      })
      expect(within(item2).queryByLabelText('确认删除')).toBeNull()
      expect(removeSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('确认态的行开始改名编辑 → 确认态复位（避免视觉打架）', () => {
    seed()
    renderWithStore(<SessionList />)

    const item = rowOf('会话一')
    fireEvent.click(within(item).getByLabelText('删除'))
    expect(within(item).getByLabelText('确认删除')).toBeInTheDocument()

    fireEvent.doubleClick(screen.getByText('会话一'))
    expect(within(item).getByLabelText('删除')).toBeInTheDocument()
    expect(within(item).queryByLabelText('确认删除')).toBeNull()
  })
})
