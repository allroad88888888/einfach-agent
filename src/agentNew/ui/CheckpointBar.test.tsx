import { describe, it, expect, afterEach, vi } from 'vitest'
import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import { checkpointsAtom, currentTurnIndexAtom } from '@web-agent/core/state/sessionAtoms'
import type { Checkpoint } from '@web-agent/core/state/checkpoint.type'
import { revertToTurn } from '@web-agent/core/runtime/commands'
import { CheckpointBar } from './CheckpointBar'

// P-U5：CheckpointBar = 右栏「回退到某一轮」的可点轮列表（在会话 store 的 Provider 下）。
// UI 隔离契约（U1）：只读 atom（checkpointsAtom / currentTurnIndexAtom）+ 调命令（revertToTurn），
// 绝不 setter atom / import writers。故 revertToTurn 用 vi.mock 打桩断言被正确调用。
vi.mock('@web-agent/core/runtime/commands', () => ({ revertToTurn: vi.fn() }))

const twoTurns: Checkpoint[] = [
  { turnIndex: 0, label: '第一轮', createdAt: 0, items: [] },
  { turnIndex: 1, label: '第二轮', createdAt: 1, items: [] },
]

describe('CheckpointBar (P-U5)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('列出各轮；点某轮→revertToTurn(turnIndex)；当前轮带 active class', () => {
    const store = createStore()
    store.setter(checkpointsAtom, twoTurns)
    store.setter(currentTurnIndexAtom, 1)

    renderWithStore(<CheckpointBar />, { store })

    // 两个轮按钮都在
    const first = screen.getByText('第一轮')
    const second = screen.getByText('第二轮')
    expect(first).toBeInTheDocument()
    expect(second).toBeInTheDocument()

    // 点「第一轮」→ revertToTurn 被以 0 调
    fireEvent.click(first)
    expect(revertToTurn).toHaveBeenCalledTimes(1)
    expect(revertToTurn).toHaveBeenCalledWith(0)

    // 当前轮（turnIndex 1 = 第二轮）带 active class；非当前轮不带
    expect(second).toHaveClass('active')
    expect(first).not.toHaveClass('active')
  })

  it('无 checkpoint（新 store）→ 渲染 null（容器不存在）', () => {
    const store = createStore()

    const { container } = renderWithStore(<CheckpointBar />, { store })

    expect(container.querySelector('.agentnew-checkpoint-bar')).toBeNull()
  })
})
