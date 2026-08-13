import { describe, expect, it, vi } from 'vitest'
import {
  disabledProjectSkillsByWorkspaceAtom,
  sessionsAtom,
} from '../state/rootStore'
import type { ProjectSkillsSnapshot } from '../skills/projectSkills'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance } from './core/coreInstance'
import { buildToolContext } from './toolContext'

function seedSession(
  core: ReturnType<typeof createCoreInstance>,
  id: string,
  workspaceRoot?: string,
  workspaceId?: string,
): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'project skills context',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      workspaceRoot,
      workspaceId,
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

  it('从清单、查找和 ensure 中一致排除当前 workspace 停用的项目 skill', async () => {
    const snapshot: ProjectSkillsSnapshot = {
      workspaceRoot: '/workspace/skills',
      entries: [
        {
          name: 'project/release-check', description: '发布检查', triggers: [],
          filePath: '.webAgent/skills/release-check/SKILL.md', resources: {}, origin: 'agent',
        },
        {
          name: 'project/legacy-guide', description: '遗留指南', triggers: [],
          filePath: '.claude/skills/legacy-guide/SKILL.md', resources: {}, origin: 'claude',
        },
      ],
      diagnostics: [],
    }
    const core = createCoreInstance({ projectSkillsProvider: vi.fn(async () => snapshot) })
    seedSession(core, 'with-disabled-skill', snapshot.workspaceRoot, 'workspace-1')
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      'workspace-1': ['project/release-check'],
    })

    const manifestContext = contextFor(core, 'with-disabled-skill')

    await expect(manifestContext.projectSkills!.ensure()).resolves.toEqual({
      ...snapshot,
      entries: [snapshot.entries[1]],
    })
    const ctx = contextFor(core, 'with-disabled-skill')
    const skills = ctx.skills!
    expect(skills.list().map((skill) => skill.name)).not.toContain('project/release-check')
    expect(skills.list().map((skill) => skill.name)).toContain('project/legacy-guide')
    expect(skills.resolveProjectPath('project/release-check')).toBeUndefined()
    expect(skills.resolveProjectPath('project/legacy-guide')).toEqual({
      filePath: '.claude/skills/legacy-guide/SKILL.md',
      resources: {},
    })
  })
})
