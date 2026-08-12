import { describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance } from './core/coreInstance'
import { buildToolContext } from './toolContext'

function seedSession(
  core: ReturnType<typeof createCoreInstance>,
  id: string,
  workspaceRoot?: string,
): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'project skills context',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      workspaceRoot,
    },
  })
  setRun(id, { runId: 'run', status: 'running' }, core)
}

function contextFor(core: ReturnType<typeof createCoreInstance>, sessionId: string) {
  return buildToolContext({
    sessionId,
    runId: 'run',
    signal: new AbortController().signal,
    callId: 'call',
    toolName: 'timed_manifest_fixture',
    core,
  })
}

describe('ToolContext projectSkills', () => {
  it('把构造期会话 workspaceRoot 绑定到实例 projectSkills.ensure', async () => {
    const snapshot = { workspaceRoot: '/workspace/skills', entries: [], diagnostics: [] }
    const provider = vi.fn(async () => snapshot)
    const core = createCoreInstance({ projectSkillsProvider: provider })
    seedSession(core, 'with-workspace', snapshot.workspaceRoot)

    const ctx = contextFor(core, 'with-workspace')

    expect(ctx.projectSkills).toBeDefined()
    await expect(ctx.projectSkills!.ensure()).resolves.toEqual(snapshot)
    expect(provider).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledWith(snapshot.workspaceRoot)
  })

  it('未绑定 workspace 的会话不暴露项目 skills 扫描入口', () => {
    const core = createCoreInstance()
    seedSession(core, 'without-workspace')

    expect(contextFor(core, 'without-workspace').projectSkills).toBeUndefined()
  })
})
