import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  sessionsAtom,
  activeSessionIdAtom,
  defaultCore,
  planAtom,
  runAtom,
  contextStatsAtom,
  pendingArtifactsAtom,
  type SessionMeta,
} from '@einfach-agent/core'
import { resetMcpSettingsState } from '../../mcp/state'
import { AppShell } from './AppShell'

// P-U6a 两栏组装：AppShell 把真组件（SessionList / ActiveSessionProvider / MessageList /
// Composer）装进「左栏 aside + 右栏 main」。这里断言组装后的真组件产物，
// 而非占位。命令一律 mock —— 渲染只读 atom，绝不触发真实副作用（起 run / 改会话）。
// P8-h 追加：AskUserQuestionCard / SaveArtifact 也挂在右栏 ActiveSessionProvider 内，
// 故把它们依赖的命令一并 mock（渲染不触发，仅补齐模块形状）。

// sessionAtomScope 是 ActiveSessionProvider 绑定会话作用域的只读通路（盘点 E7）——它必须是
// 真实实现，否则右栏 Provider 拿不到本用例 seed 过的那个会话 store。工厂里用动态 import 取，
// 避免依赖 vi.mock 提升后顶层 import 绑定的初始化时序。
vi.mock('@einfach-agent/core/runtime/commands', async () => {
  const { defaultCore: realDefaultCore } = await import('@einfach-agent/core/runtime/core/coreInstance')
  return {
    sessionAtomScope: (id: string) => realDefaultCore.getSessionStore(id).store,
    // 与 sessionAtomScope 同理必须是真实实现：UndoBar 也挂在右栏，它读的是那个会话自己的
    // 派生 atom，假 atom 会让按钮的可用态与本用例 seed 的状态脱钩。
    sessionUndoAvailabilityAtom: (id: string) =>
      realDefaultCore.getSessionStore(id).history.undoAvailabilityAtom,
    undoTurn: vi.fn(),
    redoTurn: vi.fn(),
    configureCommands: vi.fn(),
    newWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
    toggleWorkspaceExpanded: vi.fn(),
    toggleWorkspaceSettings: vi.fn(),
    newSession: vi.fn(),
    selectSession: vi.fn(),
    removeSession: vi.fn(),
    sendMessage: vi.fn(),
    stopRun: vi.fn(),
    answerQuestion: vi.fn(),
    resumeWithAnswers: vi.fn(),
    discardArtifact: vi.fn(),
    // S4：WorkspaceRootField / ToolConfirmCard 也挂在 AppShell 内，补齐它们依赖的命令形状。
    setWorkspaceRoot: vi.fn(),
    confirmTool: vi.fn(),
    approvePlan: vi.fn(),
    continuePlan: vi.fn(),
    setApprovalMode: vi.fn(),
  }
})

// 造一个登记在 rootStore 的活跃会话（P8-h 两个新挂载点都要求会话在 Provider 下）。
function seedActiveSession(id = 's1'): void {
  rootStore.setter(workspacesAtom, {
    w1: {
      id: 'w1',
      name: '示例项目',
      rootPath: '/workspace/example',
      createdAt: 0,
      updatedAt: 0,
    },
  })
  rootStore.setter(activeWorkspaceIdAtom, 'w1')
  rootStore.setter(expandedWorkspaceIdsAtom, { w1: true })
  const meta: SessionMeta = {
    id,
    title: '会话',
    settings: { vendor: 'deepseek', model: 'x' },
    createdAt: 0,
    updatedAt: 0,
    workspaceId: 'w1',
  }
  rootStore.setter(sessionsAtom, { [id]: meta })
  rootStore.setter(activeSessionIdAtom, id)
}

describe('AppShell', () => {
  afterEach(() => {
    resetMcpSettingsState(rootStore)
  })

  it('无工作区：左栏提供「新建工作区」，右栏保持空会话占位', () => {
    renderWithStore(<AppShell />)

    expect(screen.getByRole('button', { name: '新建工作区' })).toBeInTheDocument()
    expect(screen.getByText('新建工作区后即可创建对话')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /新建对话/ })).toBeNull()
    // 左栏底部：设置中心入口常驻。
    expect(screen.getByRole('button', { name: '打开设置' })).toBeInTheDocument()
    // 右栏：activeSessionId 为空 → ActiveSessionProvider 渲染空占位。
    expect(screen.getByText(/还没有会话/)).toBeInTheDocument()
    // 右栏未切到任何会话 store → 不该有 Composer 的输入框。
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('有激活会话：右栏切到会话 store → Composer 输入框在 + MessageList 空占位「开始对话吧」在', () => {
    seedActiveSession('s1')

    const { container } = renderWithStore(<AppShell />)

    // 左栏 SessionList 仍在。
    expect(screen.getByRole('button', { name: /新建对话/ })).toBeInTheDocument()
    // 右栏切到 s1 的会话 store：Composer 输入框在。
    expect(container.querySelector('.agentnew-composer-input')).not.toBeNull()
    // 工作区目录已移进标题右侧的设置面板，默认不占据对话列表空间。
    expect(screen.getByRole('button', { name: '设置 示例项目' })).toBeInTheDocument()
    expect(screen.queryByLabelText('工作区目录')).toBeNull()
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
    defaultCore.getSessionStore('s1').store.setter(runAtom, {
      runId: 'r1',
      status: 'waiting_user',
      pendingQuestion: {
        title: '需要你确认',
        questions: [{ id: 'q1', text: '继续执行吗？', type: 'confirm' }],
      },
    })

    const { container } = renderWithStore(<AppShell />)

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

  it('Plan 决策只在 Plan 内显示一次，不再落到 Composer 上方的普通提问槽', () => {
    seedActiveSession('s1')
    const store = defaultCore.getSessionStore('s1').store
    store.setter(planAtom, {
      id: 'p1', title: '实现功能', objective: '交付功能', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 1,
      stages: [{
        id: 'build', title: '实现', objective: '写代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    const payload = {
      title: '确认兼容范围',
      questions: [{ id: 'compat', text: '保留旧行为吗？', type: 'confirm' }],
    }
    store.setter(runAtom, {
      runId: 'r1',
      status: 'waiting_user',
      pendingQuestion: payload,
      pendingUserDecision: {
        callId: 'ask1',
        payload,
        origin: { surface: 'plan', phase: 'executing', planId: 'p1', planRevision: 1, stageId: 'build' },
      },
    })

    const { container } = renderWithStore(<AppShell />)

    expect(container.querySelectorAll('.agentnew-ask')).toHaveLength(1)
    expect(container.querySelector('.agentnew-plan-stage-body .agentnew-ask')).not.toBeNull()
  })

  it('会话有待保存产物：右栏 ActiveSessionProvider 内挂出 SaveArtifact', () => {
    seedActiveSession('s1')
    // 在该会话 store 上 seed 一个待保存产物，让默认渲染 null 的 SaveArtifact 显形。
    defaultCore.getSessionStore('s1').store.setter(pendingArtifactsAtom, [
      { id: 'a1', filename: 'plan.md', content: '# Plan', mimeType: 'text/markdown' },
    ])

    const { container } = renderWithStore(<AppShell />)

    // SaveArtifact 显形 = 挂载点存在于右栏 Provider 下。
    expect(container.querySelector('[aria-label="待保存文件"]')).not.toBeNull()
    expect(screen.getByText('plan.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument()
  })

  it('会话有 context stats：右栏输入区上方挂出上下文统计', () => {
    seedActiveSession('s1')
    defaultCore.getSessionStore('s1').store.setter(contextStatsAtom, {
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

    const { container } = renderWithStore(<AppShell />)

    const stats = container.querySelector('.agentnew-context-stats')
    const composer = container.querySelector('.agentnew-composer')
    expect(stats).not.toBeNull()
    expect(composer).not.toBeNull()
    expect(screen.getByText('上下文 0%')).toBeInTheDocument()
    expect(stats!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
