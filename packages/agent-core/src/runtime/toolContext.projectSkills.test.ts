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

// ctx 上没有扫描入口：扫描只发生在组 L1 清单时（buildStableModelPrefix ensure 一次，见
// modelTurnPrefix.test.ts），工具侧只读那一次留下的缓存。所以这些用例先手动 ensure 一次，
// 再看 ctx 读到什么。
describe('ToolContext 上的项目 skills', () => {
  it('未绑定 workspace 的会话只看得到内置 skill', () => {
    const core = createCoreInstance()
    seedSession(core, 'without-workspace')

    const skills = contextFor(core, 'without-workspace').skills!
    expect(skills.list().every((skill) => !skill.name.includes('/'))).toBe(true)
    expect(skills.resolveScannedSkill('project/anything')).toBeUndefined()
  })

  it('从清单与查找中一致排除当前 workspace 停用的项目 skill', async () => {
    const snapshot: ProjectSkillsSnapshot = {
      workspaceRoot: '/workspace/skills',
      entries: [
        {
          name: 'project/release-check', description: '发布检查', triggers: [],
          filePath: '.webAgent/skills/release-check/SKILL.md', resources: {}, origin: 'agent', scope: 'project' as const, rootPath: '/workspace',
        },
        {
          name: 'project/legacy-guide', description: '遗留指南', triggers: [],
          filePath: '.claude/skills/legacy-guide/SKILL.md', resources: {}, origin: 'claude', scope: 'project' as const, rootPath: '/workspace',
        },
      ],
      diagnostics: [],
    }
    const core = createCoreInstance({ projectSkillsProvider: vi.fn(async () => snapshot) })
    seedSession(core, 'with-disabled-skill', snapshot.workspaceRoot, 'workspace-1')
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      'workspace-1': ['project/release-check'],
    })

    await core.projectSkills.ensure(snapshot.workspaceRoot)
    const ctx = contextFor(core, 'with-disabled-skill')
    const skills = ctx.skills!
    expect(skills.list().map((skill) => skill.name)).not.toContain('project/release-check')
    expect(skills.list().map((skill) => skill.name)).toContain('project/legacy-guide')
    expect(skills.resolveScannedSkill('project/release-check')).toBeUndefined()
    expect(skills.resolveScannedSkill('project/legacy-guide')).toEqual({
      filePath: '.claude/skills/legacy-guide/SKILL.md',
      resources: {},
      rootPath: '/workspace',
    })
  })

  it('读取根跟着条目走：主目录条目与被链接进来的条目各用自己的根，都不是会话 workspace', async () => {
    const snapshot: ProjectSkillsSnapshot = {
      workspaceRoot: '/workspace/skills',
      userSkillsRoot: '/home/me',
      entries: [
        {
          name: 'user/deploy', description: '部署', triggers: [],
          filePath: '.claude/skills/deploy/SKILL.md', resources: {}, origin: 'claude',
          scope: 'user', rootPath: '/home/me',
        },
        {
          // 符号链接进来的 skill：根是它自己那个目录，既不在 workspace 里也不在主目录里。
          name: 'user/linked', description: '被链接的', triggers: [],
          filePath: 'SKILL.md', resources: {}, origin: 'claude',
          scope: 'user', rootPath: '/elsewhere/repo/skills/linked',
        },
      ],
      diagnostics: [],
    }
    const core = createCoreInstance({ projectSkillsProvider: vi.fn(async () => snapshot) })
    seedSession(core, 'with-user-skill', snapshot.workspaceRoot, 'workspace-1')
    await core.projectSkills.ensure(snapshot.workspaceRoot)
    const skills = contextFor(core, 'with-user-skill').skills!

    expect(skills.resolveScannedSkill('user/deploy')).toEqual({
      filePath: '.claude/skills/deploy/SKILL.md',
      resources: {},
      rootPath: '/home/me',
    })
    expect(skills.resolveScannedSkill('user/linked')).toEqual({
      filePath: 'SKILL.md',
      resources: {},
      rootPath: '/elsewhere/repo/skills/linked',
    })
  })
})
