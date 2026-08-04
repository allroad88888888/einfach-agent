import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistenceBridge', () => ({
  persistDeleteSession: vi.fn(),
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
}))

import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  sessionsAtom,
  workspacesAtom,
} from '../../state/rootStore'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { persistDeleteSession, persistSessions, persistWorkspaces } from '../persistenceBridge'
import { DEFAULT_SESSION_TITLE, createSessionCommands } from './sessionCommands'

let core: CoreInstance
let commands: ReturnType<typeof createSessionCommands>

beforeEach(() => {
  core = createCoreInstance()
  commands = createSessionCommands(core)
})

describe('sessionCommands', () => {
  it('新建会话时创建默认工作区与会话 store，并持久化两类元数据', () => {
    const id = commands.newSession()
    const session = core.rootStore.getter(sessionsAtom)[id]

    if (!session) throw new Error('预期新会话已登记')

    expect(session).toMatchObject({ title: DEFAULT_SESSION_TITLE, workspaceId: expect.any(String) })
    expect(session.settings).toEqual({ vendor: 'deepseek', model: 'deepseek-v4-flash' })
    expect(core.rootStore.getter(workspacesAtom)[session.workspaceId!]).toBeTruthy()
    expect(core.getSessionStore(id)).toBeTruthy()
    expect(core.rootStore.getter(activeWorkspaceIdAtom)).toBe(session.workspaceId)
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(id)
    expect(persistWorkspaces).toHaveBeenCalledOnce()
    expect(persistSessions).toHaveBeenCalledOnce()
  })

  it('显式指定模型时不覆盖用户选择', () => {
    const id = commands.newSession({
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    })

    expect(core.rootStore.getter(sessionsAtom)[id].settings).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
    })
  })

  it('选择会话会同步其工作区，重命名和授权模式会持久化', () => {
    const first = commands.newSession()
    const second = commands.newSession({ title: '目标会话' })
    vi.mocked(persistSessions).mockClear()

    commands.selectSession(first)
    commands.renameSession(first, '  已改名  ')
    commands.setApprovalMode('auto')

    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(first)
    expect(core.rootStore.getter(activeWorkspaceIdAtom))
      .toBe(core.rootStore.getter(sessionsAtom)[first].workspaceId)
    expect(core.rootStore.getter(sessionsAtom)[first]).toMatchObject({
      title: '已改名',
      toolApprovalMode: 'auto',
    })
    expect(core.rootStore.getter(sessionsAtom)[second].title).toBe('目标会话')
    expect(persistSessions).toHaveBeenCalledTimes(2)
  })

  it('删除当前会话会终止 run、清理元数据并持久化删除', () => {
    const first = commands.newSession()
    const second = commands.newSession()
    const abortRun = vi.spyOn(core.abort, 'abortRun')
    vi.clearAllMocks()

    commands.removeSession(second)

    expect(abortRun).toHaveBeenCalledWith(second)
    expect(core.rootStore.getter(sessionsAtom)[second]).toBeUndefined()
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(first)
    expect(persistSessions).toHaveBeenCalledOnce()
    expect(persistDeleteSession).toHaveBeenCalledWith(second)
  })
})
