import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  sessionsAtom,
  workspacesAtom,
} from '../../state/rootStore'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { DEFAULT_SESSION_TITLE, createSessionCommands } from './sessionCommands'

let core: CoreInstance
let commands: ReturnType<typeof createSessionCommands>
let persistSessions: ReturnType<typeof vi.spyOn>
let persistWorkspaces: ReturnType<typeof vi.spyOn>
let persistDeleteSession: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  core = createCoreInstance()
  persistSessions = vi.spyOn(core.persistence, 'persistSessions')
  persistWorkspaces = vi.spyOn(core.persistence, 'persistWorkspaces')
  persistDeleteSession = vi.spyOn(core.persistence, 'persistDeleteSession')
  commands = createSessionCommands(core)
})

describe('sessionCommands', () => {
  it('persists CRUD only through the owning core bridge', async () => {
    const other = createCoreInstance()
    const ownSave = vi.fn(async () => {})
    const otherSave = vi.fn(async () => {})
    const driver = (saveSessions: typeof ownSave) => ({
      saveSessions, loadSessions: vi.fn(async () => []),
      saveWorkspaces: vi.fn(async () => {}), loadWorkspaces: vi.fn(async () => []),
    })
    core.persistence.configure({ sessions: driver(ownSave) })
    other.persistence.configure({ sessions: driver(otherSave) })

    commands.newSession()
    await core.persistence.flush()
    await other.persistence.flush()

    expect(ownSave).toHaveBeenCalledOnce()
    expect(otherSave).not.toHaveBeenCalled()
  })

  it('新建会话时创建默认工作区与会话 store，并持久化两类元数据', () => {
    const id = commands.newSession()
    const session = core.rootStore.getter(sessionsAtom)[id]

    if (!session) throw new Error('预期新会话已登记')

    expect(session).toMatchObject({ title: DEFAULT_SESSION_TITLE, workspaceId: expect.any(String) })
    expect(session.settings).toEqual({ vendor: 'deepseek', model: 'deepseek-flash' })
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
