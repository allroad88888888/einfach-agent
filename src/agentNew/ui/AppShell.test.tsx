import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '../state/rootStore'
import { resetSessionStores } from '../state/sessionStore'
import { AppShell } from './AppShell'

// P-U6a 两栏组装：AppShell 把真组件（SessionList / ActiveSessionProvider / MessageList /
// CheckpointBar / Composer）装进「左栏 aside + 右栏 main」。这里断言组装后的真组件产物，
// 而非占位。命令一律 mock —— 渲染只读 atom，绝不触发真实副作用（起 run / 改会话）。

vi.mock('../runtime/commands', () => ({
  newSession: vi.fn(),
  selectSession: vi.fn(),
  removeSession: vi.fn(),
  sendMessage: vi.fn(),
  stopRun: vi.fn(),
  revertToTurn: vi.fn(),
}))

describe('AppShell', () => {
  afterEach(() => {
    resetRootStore()
    resetSessionStores()
  })

  it('无激活会话：左栏 SessionList「+ 新建对话」在 + 右栏 empty 占位「还没有会话」在', () => {
    renderWithStore(<AppShell />, { store: rootStore })

    // 左栏：SessionList 的新建按钮常驻。
    expect(screen.getByRole('button', { name: /新建对话/ })).toBeInTheDocument()
    // 右栏：activeSessionId 为空 → ActiveSessionProvider 渲染空占位。
    expect(screen.getByText(/还没有会话/)).toBeInTheDocument()
    // 右栏未切到任何会话 store → 不该有 Composer 的输入框。
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('有激活会话：右栏切到会话 store → Composer 输入框在 + MessageList 空占位「开始对话吧」在', () => {
    rootStore.setter(sessionsAtom, {
      s1: {
        id: 's1',
        title: '会话',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    rootStore.setter(activeSessionIdAtom, 's1')

    renderWithStore(<AppShell />, { store: rootStore })

    // 左栏 SessionList 仍在。
    expect(screen.getByRole('button', { name: /新建对话/ })).toBeInTheDocument()
    // 右栏切到 s1 的会话 store：Composer 输入框在。
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    // 该会话 items 为空 → MessageList 空占位。
    expect(screen.getByText(/开始对话吧/)).toBeInTheDocument()
    // 已有 active → 不再是「还没有会话」空占位。
    expect(screen.queryByText(/还没有会话/)).toBeNull()
  })
})
