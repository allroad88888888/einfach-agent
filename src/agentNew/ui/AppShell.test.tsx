import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '@web-agent/core/state/rootStore'
import { getSessionStore, resetSessionStores } from '@web-agent/core/state/sessionStore'
import { runAtom } from '@web-agent/core/state/sessionAtoms'
import { contextStatsAtom, pendingArtifactsAtom } from '@web-agent/core/state/transientAtoms'
import type { SessionMeta } from '@web-agent/core/state/core.type'
import { AppShell } from './AppShell'

// P-U6a 两栏组装：AppShell 把真组件（SessionList / ActiveSessionProvider / MessageList /
// CheckpointBar / Composer）装进「左栏 aside + 右栏 main」。这里断言组装后的真组件产物，
// 而非占位。命令一律 mock —— 渲染只读 atom，绝不触发真实副作用（起 run / 改会话）。
// P8-h 追加：AskUserQuestionCard / SaveArtifact 也挂在右栏 ActiveSessionProvider 内，
// 故把它们依赖的命令一并 mock（渲染不触发，仅补齐模块形状）。

vi.mock('@web-agent/core/runtime/commands', () => ({
  newSession: vi.fn(),
  selectSession: vi.fn(),
  removeSession: vi.fn(),
  sendMessage: vi.fn(),
  stopRun: vi.fn(),
  revertToTurn: vi.fn(),
  answerQuestion: vi.fn(),
  resumeWithAnswers: vi.fn(),
  discardArtifact: vi.fn(),
  // S4：WorkspaceRootField / ToolConfirmCard 也挂在 AppShell 内，补齐它们依赖的命令形状。
  setWorkspaceRoot: vi.fn(),
  confirmTool: vi.fn(),
  approvePlan: vi.fn(),
}))

// 造一个登记在 rootStore 的活跃会话（P8-h 两个新挂载点都要求会话在 Provider 下）。
function seedActiveSession(id = 's1'): void {
  const meta: SessionMeta = {
    id,
    title: '会话',
    settings: { vendor: 'deepseek', model: 'x' },
    createdAt: 0,
    updatedAt: 0,
  }
  rootStore.setter(sessionsAtom, { [id]: meta })
  rootStore.setter(activeSessionIdAtom, id)
}

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

    const { container } = renderWithStore(<AppShell />, { store: rootStore })

    // 左栏 SessionList 仍在。
    expect(screen.getByRole('button', { name: /新建对话/ })).toBeInTheDocument()
    // 右栏切到 s1 的会话 store：Composer 输入框在（有 active 后左栏还会多出 WorkspaceRootField 的输入，
    //   故不用 getByRole('textbox') 泛查，直接定位 Composer 的输入元素）。
    expect(container.querySelector('.agentnew-composer-input')).not.toBeNull()
    // S4-A：左栏 WorkspaceRootField 随 active 会话出现（工作目录绑定入口）。
    expect(screen.getByLabelText('工作目录')).toBeInTheDocument()
    // 该会话 items 为空 → MessageList 空占位。
    expect(screen.getByText(/开始对话吧/)).toBeInTheDocument()
    // 已有 active → 不再是「还没有会话」空占位。
    expect(screen.queryByText(/还没有会话/)).toBeNull()
  })

  it('run 停在 waiting_user：右栏 ActiveSessionProvider 内挂出 AskUserQuestionCard（紧贴 Composer 上方）', () => {
    seedActiveSession('s1')
    // 在该会话 store 上 seed 一个「暂停等待补充」的 run，让默认渲染 null 的
    // AskUserQuestionCard 显形——从而证明它确实被挂在右栏 Provider 内。
    // 用 confirm 题以免多出一个 textbox 干扰对 Composer textbox 的断言。
    getSessionStore('s1').store.setter(runAtom, {
      runId: 'r1',
      status: 'waiting_user',
      pendingQuestion: {
        title: '需要你确认',
        questions: [{ id: 'q1', text: '继续执行吗？', type: 'confirm' }],
      },
    })

    const { container } = renderWithStore(<AppShell />, { store: rootStore })

    // AskUserQuestionCard 显形 = 挂载点存在于右栏 Provider 下。
    const ask = container.querySelector('.agentnew-ask')
    expect(ask).not.toBeNull()
    expect(screen.getByText('需要你确认')).toBeInTheDocument()
    expect(screen.getByText('继续执行吗？')).toBeInTheDocument()

    // 位置：紧贴输入区上方 —— 卡片在 DOM 中排在 Composer 之前。
    const composer = container.querySelector('.agentnew-composer')
    expect(composer).not.toBeNull()
    expect(ask!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('会话有待保存产物：右栏 ActiveSessionProvider 内挂出 SaveArtifact（在 CheckpointBar 之前）', () => {
    seedActiveSession('s1')
    // 在该会话 store 上 seed 一个待保存产物，让默认渲染 null 的 SaveArtifact 显形。
    getSessionStore('s1').store.setter(pendingArtifactsAtom, [
      { id: 'a1', filename: 'plan.md', content: '# Plan', mimeType: 'text/markdown' },
    ])

    const { container } = renderWithStore(<AppShell />, { store: rootStore })

    // SaveArtifact 显形 = 挂载点存在于右栏 Provider 下。
    expect(container.querySelector('[aria-label="待保存文件"]')).not.toBeNull()
    expect(screen.getByText('plan.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument()
  })

  it('会话有 context stats：右栏输入区上方挂出上下文统计', () => {
    seedActiveSession('s1')
    getSessionStore('s1').store.setter(contextStatsAtom, {
      id: 'ctx1',
      createdAt: 1,
      vendor: 'deepseek',
      model: 'x',
      runId: 'r1',
      turnId: 'u1',
      llmTurn: 1,
      messagesCount: 2,
      toolsCount: 1,
      systemChars: 10,
      messagesChars: 20,
      toolsChars: 30,
      totalChars: 50,
      estimatedTokens: 13,
      roles: {
        system: { count: 1, chars: 10, estimatedTokens: 3 },
        user: { count: 1, chars: 10, estimatedTokens: 3 },
        assistant: { count: 0, chars: 0, estimatedTokens: 0 },
        tool: { count: 0, chars: 0, estimatedTokens: 0 },
      },
      toolNames: ['request_tool_schema'],
    })

    const { container } = renderWithStore(<AppShell />, { store: rootStore })

    const stats = container.querySelector('.agentnew-context-stats')
    const composer = container.querySelector('.agentnew-composer')
    expect(stats).not.toBeNull()
    expect(composer).not.toBeNull()
    expect(screen.getByText(/上下文估算 13 tokens/)).toBeInTheDocument()
    expect(stats!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
