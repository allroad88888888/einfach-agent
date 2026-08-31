import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistenceBridge', () => ({
  persistWorkspaces: vi.fn(),
  persistSessions: vi.fn(),
  persistDeleteSession: vi.fn(),
}))

import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  sessionsAtom,
  workspacesAtom,
  workspaceSettingsOpenIdsAtom,
} from '../../state/rootStore'
import type { SessionMeta } from '../../state/core.type'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { persistWorkspaces } from '../persistenceBridge'
import { createSessionCommands } from './sessionCommands'
import { createWorkspaceCommands } from './workspaceCommands'

let core: CoreInstance
let commands: ReturnType<typeof createWorkspaceCommands>

beforeEach(() => {
  core = createCoreInstance()
  const session = createSessionCommands(core)
  commands = createWorkspaceCommands(core, { removeSession: session.removeSession })
})

describe('workspaceCommands', () => {
  it('新建工作区时规范化路径，重复路径改为激活既有工作区', () => {
    const id = commands.newWorkspace({ rootPath: ' /Users/me/project ' })
    const duplicate = commands.newWorkspace({ rootPath: '/Users/me/project' })

    expect(duplicate).toBe(id)
    expect(core.rootStore.getter(workspacesAtom)[id]).toMatchObject({
      name: 'project',
      rootPath: '/Users/me/project',
    })
    expect(core.rootStore.getter(activeWorkspaceIdAtom)).toBe(id)
    expect(core.rootStore.getter(expandedWorkspaceIdsAtom)[id]).toBe(true)
    expect(persistWorkspaces).toHaveBeenCalledOnce()
  })

  it('选择工作区时激活其中最近更新的会话', () => {
    const workspaceId = commands.newWorkspace({ name: '项目' })
    const sessions: Record<string, SessionMeta> = {
      old: {
        id: 'old', title: '旧会话', settings: { vendor: 'deepseek', model: 'm' },
        createdAt: 1, updatedAt: 1, workspaceId,
      },
      latest: {
        id: 'latest', title: '新会话', settings: { vendor: 'deepseek', model: 'm' },
        createdAt: 2, updatedAt: 2, workspaceId,
      },
    }
    core.rootStore.setter(sessionsAtom, sessions)
    core.rootStore.setter(activeSessionIdAtom, 'other')

    commands.selectWorkspace(workspaceId)

    expect(core.rootStore.getter(activeSessionIdAtom)).toBe('latest')
  })

  it('工作区设置、改名与根目录更新都写入同一工作区', () => {
    const id = commands.newWorkspace()
    vi.mocked(persistWorkspaces).mockClear()

    commands.toggleWorkspaceExpanded(id)
    commands.toggleWorkspaceSettings(id)
    commands.renameWorkspace(id, '  新标题  ')
    commands.setWorkspaceRoot(' /repo/demo ')

    expect(core.rootStore.getter(expandedWorkspaceIdsAtom)[id]).toBe(true)
    expect(core.rootStore.getter(workspaceSettingsOpenIdsAtom)).toEqual({ [id]: true })
    expect(core.rootStore.getter(workspacesAtom)[id]).toMatchObject({
      name: '新标题',
      rootPath: '/repo/demo',
    })
    expect(persistWorkspaces).toHaveBeenCalledTimes(2)
  })

  it('移除工作区会清理其中会话并切换到剩余工作区', () => {
    const first = commands.newWorkspace({ name: '一号' })
    const firstSession = createSessionCommands(core).newSession({ workspaceId: first })
    const second = commands.newWorkspace({ name: '二号' })
    const secondSession = createSessionCommands(core).newSession({ workspaceId: second })

    commands.removeWorkspace(second)

    expect(core.rootStore.getter(workspacesAtom)[second]).toBeUndefined()
    expect(core.rootStore.getter(sessionsAtom)[secondSession]).toBeUndefined()
    expect(core.rootStore.getter(workspacesAtom)[first]).toBeTruthy()
    expect(core.rootStore.getter(sessionsAtom)[firstSession]).toBeTruthy()
    expect(core.rootStore.getter(activeWorkspaceIdAtom)).toBe(first)
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(firstSession)
  })
})
