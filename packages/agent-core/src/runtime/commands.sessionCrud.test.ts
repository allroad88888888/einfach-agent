// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：会话/工作区 CRUD + 起 run。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：命令是否按约定调用了 beginRun/runSession/endRun/abortRun，
// 以及是否正确读写 rootStore（sessionsAtom/activeSessionIdAtom）和 sessionStore
// （getSessionStore）。真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('../state/checkpointWriters', () => ({
  jumpToCheckpoint: vi.fn(),
  rewindBeforeCheckpoint: vi.fn(),
  revertToPlanStageCheckpoint: vi.fn(),
  updateCheckpoint: vi.fn(),
}))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
  persistCheckpoint: vi.fn(),
}))

import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  sessionsAtom,
  activeSessionIdAtom,
} from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/transientAtoms'
import { resumeInterruptedSession, runSession } from './modelRun'
import {
  persistSessions,
  persistWorkspaces,
  persistDeleteSession,
} from './persistenceBridge'
import {
  configureCommands,
  newWorkspace,
  renameWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
  newSession,
  selectSession,
  removeSession,
  sendMessage,
  continueInterruptedRun,
} from './commands'
import { flush, spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let beginRun: AbortSpies['beginRun']
let abortRun: AbortSpies['abortRun']
let endRun: AbortSpies['endRun']

beforeEach(() => {
  ;({ beginRun, abortRun, endRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('commands（P-R3 UI 唯一入口 · 不收 store）', () => {
  it('newSession：登记 sessionsAtom + 设为 active + 建 session store', () => {
    const before = Object.keys(rootStore.getter(sessionsAtom)).length
    const id = newSession()

    const sessions = rootStore.getter(sessionsAtom)
    expect(Object.keys(sessions)).toHaveLength(before + 1)
    expect(sessions[id]).toBeTruthy()
    expect(sessions[id].settings.vendor).toBe('deepseek')
    expect(rootStore.getter(activeSessionIdAtom)).toBe(id)
    expect(getSessionStore(id)).toBeTruthy()
    // D-4：新建会话后落盘会话列表。
    expect(persistSessions).toHaveBeenCalled()
  })

  it('newSession：opts.title / opts.settings 覆盖默认', () => {
    const id = newSession({
      title: '我的会话',
      settings: { vendor: 'glm', model: 'glm-x' },
    })
    const meta = rootStore.getter(sessionsAtom)[id]
    expect(meta.title).toBe('我的会话')
    expect(meta.settings).toEqual({ vendor: 'glm', model: 'glm-x' })
  })

  it('selectSession：切 activeSessionIdAtom', () => {
    selectSession('x')
    expect(rootStore.getter(activeSessionIdAtom)).toBe('x')
  })

  it('工作区：新建后激活并展开；工作区内可新建多个对话', () => {
    const workspaceId = newWorkspace({ rootPath: ' /Users/me/project ' })
    const first = newSession({ workspaceId })
    const second = newSession({ workspaceId })

    expect(rootStore.getter(workspacesAtom)[workspaceId]).toMatchObject({
      name: 'project',
      rootPath: '/Users/me/project',
    })
    expect(rootStore.getter(activeWorkspaceIdAtom)).toBe(workspaceId)
    expect(rootStore.getter(expandedWorkspaceIdsAtom)[workspaceId]).toBe(true)
    expect(rootStore.getter(sessionsAtom)[first].workspaceId).toBe(workspaceId)
    expect(rootStore.getter(sessionsAtom)[second].workspaceId).toBe(workspaceId)
    expect(persistWorkspaces).toHaveBeenCalled()
  })

  it('工作区：可折叠，重新选择时展开并切到该工作区最近的对话', () => {
    const firstWorkspace = newWorkspace({ name: '一号' })
    newSession({ workspaceId: firstWorkspace, title: '旧对话' })
    const secondWorkspace = newWorkspace({ name: '二号' })
    const secondSession = newSession({ workspaceId: secondWorkspace, title: '新对话' })

    toggleWorkspaceExpanded(secondWorkspace)
    expect(rootStore.getter(expandedWorkspaceIdsAtom)[secondWorkspace]).toBe(false)

    selectWorkspace(firstWorkspace)
    selectWorkspace(secondWorkspace)
    expect(rootStore.getter(expandedWorkspaceIdsAtom)[secondWorkspace]).toBe(true)
    expect(rootStore.getter(activeSessionIdAtom)).toBe(secondSession)
  })

  it('工作区：设置按钮激活并展开目标工作区，标题可重命名并持久化', () => {
    const workspaceId = newWorkspace({ name: '旧标题' })
    toggleWorkspaceExpanded(workspaceId)
    expect(rootStore.getter(expandedWorkspaceIdsAtom)[workspaceId]).toBe(false)

    toggleWorkspaceSettings(workspaceId)
    expect(rootStore.getter(activeWorkspaceIdAtom)).toBe(workspaceId)
    expect(rootStore.getter(expandedWorkspaceIdsAtom)[workspaceId]).toBe(true)
    expect(rootStore.getter(workspaceSettingsOpenIdsAtom)[workspaceId]).toBe(true)

    toggleWorkspaceSettings(workspaceId)
    expect(rootStore.getter(workspaceSettingsOpenIdsAtom)).toEqual({})

    vi.mocked(persistWorkspaces).mockClear()
    renameWorkspace(workspaceId, '  新标题  ')
    expect(rootStore.getter(workspacesAtom)[workspaceId].name).toBe('新标题')
    expect(persistWorkspaces).toHaveBeenCalled()
  })

  it('removeSession：从 sessionsAtom 删除该 id', () => {
    const a = newSession()
    const b = newSession()
    removeSession(a)

    const sessions = rootStore.getter(sessionsAtom)
    expect(sessions[a]).toBeUndefined()
    expect(sessions[b]).toBeTruthy()
  })

  it('removeSession：删的是当前 active → active 落到剩余任一 id', () => {
    const a = newSession()
    const b = newSession() // b 现在是 active
    removeSession(b)
    // active 落到剩余的 a。
    expect(rootStore.getter(activeSessionIdAtom)).toBe(a)
  })

  it('removeSession：删最后一个 active → active 置空串', () => {
    const a = newSession()
    removeSession(a)
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })

  it('removeSession：先 abort 该会话正在跑的 run（避免 controller 泄漏）', () => {
    const a = newSession()
    removeSession(a)
    expect(abortRun).toHaveBeenCalledWith(a)
  })

  it('removeSession：落盘会话列表 + 清盘该会话历史（D-4）', () => {
    const a = newSession()
    vi.mocked(persistSessions).mockClear()
    removeSession(a)
    expect(persistSessions).toHaveBeenCalled()
    expect(persistDeleteSession).toHaveBeenCalledWith(a)
  })

  it('sendMessage：起 run（beginRun→runSession，apiKey 按 vendor 取）', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession() // deepseek 默认

    await sendMessage('hi')

    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runSession).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runSession).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('hi')
    expect(call[2].apiKey).toBe('k')

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('sendMessage：vendor=glm → 取 modelCredentials.glm', async () => {
    configureCommands({ modelCredentials: { deepseek: 'dk', glm: 'gk' } })
    newSession({ settings: { vendor: 'glm', model: 'glm-x' } })

    await sendMessage('hi')
    expect(vi.mocked(runSession).mock.calls[0][2].apiKey).toBe('gk')
  })

  it('sendMessage：空输入 → 不起 run', () => {
    newSession()
    sendMessage('   ')
    expect(runSession).not.toHaveBeenCalled()
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('sendMessage：无 active 会话 → 不起 run', () => {
    sendMessage('hi')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('sendMessage：running/awaiting_tool 时绑定当前 run 进入 FIFO 队列，不另起 run', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'r', status: 'running' })

    await sendMessage(' 第一条 ')
    store.setter(runAtom, { runId: 'r', status: 'awaiting_tool' })
    await sendMessage('第二条')

    expect(store.getter(queuedUserMessagesAtom)).toEqual([
      expect.objectContaining({ content: '第一条', targetRunId: 'r' }),
      expect.objectContaining({ content: '第二条', targetRunId: 'r' }),
    ])
    expect(runSession).not.toHaveBeenCalled()
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('sendMessage：结构化决策暂停时仍 no-op，不能绕过未回填的 tool call', () => {
    const id = newSession()
    const store = getSessionStore(id).store
    for (const status of ['waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'interrupted'] as const) {
      store.setter(runAtom, { runId: 'r', status })
      sendMessage('hi')
    }

    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(runSession).not.toHaveBeenCalled()
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('continueInterruptedRun：沿用恢复出的 run 继续普通任务，不追加用户消息', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '继续这个任务' } },
    ])
    store.setter(runAtom, {
      runId: 'run-before-restart',
      turnId: 'u1',
      status: 'interrupted',
    })

    continueInterruptedRun()

    expect(resumeInterruptedSession).toHaveBeenCalledOnce()
    expect(vi.mocked(resumeInterruptedSession).mock.calls[0][0]).toBe(id)
    expect(store.getter(itemsAtom)).toHaveLength(1)
    expect(runSession).not.toHaveBeenCalled()
    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })
})
