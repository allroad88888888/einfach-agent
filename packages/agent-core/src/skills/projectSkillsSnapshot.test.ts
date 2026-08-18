import type { ProjectSkillEntry, ProjectSkillOrigin, ProjectSkillScope } from './projectSkills'
import {
  emptyProjectSkillsSnapshot,
  MAX_PROJECT_SKILLS,
  resolveProjectSkills,
  type ProjectSkillScanResult,
} from './projectSkillsSnapshot'
import { describe, expect, it } from 'vitest'

describe('resolveProjectSkills', () => {
  function makeEntry(
    name: string,
    origin: ProjectSkillOrigin = 'agent',
    scope: ProjectSkillScope = 'project',
  ): ProjectSkillEntry {
    const directory = origin === 'agent' ? '.webAgent/skills' : '.claude/skills'
    return {
      name: `${scope}/${name}`,
      description: `description for ${name}`,
      triggers: [],
      rootPath: scope === 'user' ? '/home/me' : '/test',
      filePath: `${directory}/${name}/SKILL.md`,
      resources: {},
      origin,
      scope,
    }
  }

  function scan(
    entries: ProjectSkillEntry[],
    diagnostics: string[] = [],
    origin: ProjectSkillOrigin = 'agent',
    scope: ProjectSkillScope = 'project',
  ): ProjectSkillScanResult {
    return { scope, origin, entries, diagnostics }
  }

  it('空输入 → 空快照', () => {
    const snapshot = resolveProjectSkills({ workspaceRoot: '/test', scans: [] })
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.workspaceRoot).toBe('/test')
    expect(snapshot.userSkillsRoot).toBeUndefined()
  })

  it('.webAgent 与 .claude 撞名 → .webAgent 胜', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      scans: [
        scan([makeEntry('deploy', 'agent')]),
        scan([makeEntry('deploy', 'claude')], [], 'claude'),
      ],
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].origin).toBe('agent')
    expect(snapshot.diagnostics.some((d) => d.includes('同名') && d.includes('.claude/skills'))).toBe(true)
  })

  it('不撞名时两路合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      scans: [
        scan([makeEntry('deploy', 'agent')]),
        scan([makeEntry('legacy', 'claude')], [], 'claude'),
      ],
    })
    expect(snapshot.entries).toHaveLength(2)
  })

  it('按名字字节序排序', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      scans: [
        scan([makeEntry('zebra'), makeEntry('alpha'), makeEntry('mike')]),
      ],
    })
    expect(snapshot.entries.map((e) => e.name)).toEqual(['project/alpha', 'project/mike', 'project/zebra'])
  })

  it('超过 MAX_PROJECT_SKILLS 截断', () => {
    const entries = Array.from({ length: MAX_PROJECT_SKILLS + 5 }, (_, i) =>
      makeEntry(`skill-${String(i).padStart(3, '0')}`),
    )
    const snapshot = resolveProjectSkills({ workspaceRoot: '/test', scans: [scan(entries)] })
    expect(snapshot.entries).toHaveLength(MAX_PROJECT_SKILLS)
    expect(snapshot.diagnostics.some((d) => d.includes('超过上限'))).toBe(true)
  })

  it('diagnostics 合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      scans: [scan([], ['agent warning']), scan([], ['claude warning'], 'claude')],
    })
    expect(snapshot.diagnostics).toContain('agent warning')
    expect(snapshot.diagnostics).toContain('claude warning')
  })

  // === 用户作用域 =========================================================

  it('同名的工作区与用户目录 skill 并存（前缀不同，不撞名）', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      userSkillsRoot: '/home/me',
      scans: [
        scan([makeEntry('deploy', 'agent', 'project')]),
        scan([makeEntry('deploy', 'agent', 'user')], [], 'agent', 'user'),
      ],
    })
    expect(snapshot.entries.map((e) => e.name)).toEqual(['project/deploy', 'user/deploy'])
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.userSkillsRoot).toBe('/home/me')
  })

  it('用户目录内部仍按 .webAgent 胜 .claude 裁决', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      userSkillsRoot: '/home/me',
      scans: [
        scan([makeEntry('deploy', 'agent', 'user')], [], 'agent', 'user'),
        scan([makeEntry('deploy', 'claude', 'user')], [], 'claude', 'user'),
      ],
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].origin).toBe('agent')
    expect(snapshot.diagnostics[0]).toContain('~/.claude/skills/deploy')
    expect(snapshot.diagnostics[0]).toContain('~/.webAgent/skills')
  })

  it('上限按作用域各算一份：主目录塞满不挤掉工作区的 skill', () => {
    const userEntries = Array.from({ length: MAX_PROJECT_SKILLS + 3 }, (_, i) =>
      makeEntry(`user-skill-${String(i).padStart(3, '0')}`, 'agent', 'user'),
    )
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      userSkillsRoot: '/home/me',
      scans: [
        scan([makeEntry('deploy')]),
        scan(userEntries, [], 'agent', 'user'),
      ],
    })
    expect(snapshot.entries.filter((e) => e.scope === 'project')).toHaveLength(1)
    expect(snapshot.entries.filter((e) => e.scope === 'user')).toHaveLength(MAX_PROJECT_SKILLS)
    expect(snapshot.diagnostics.some((d) => d.includes('用户级 skills 总数'))).toBe(true)
  })
})

// ===========================================================================
// emptyProjectSkillsSnapshot
// ===========================================================================

describe('emptyProjectSkillsSnapshot', () => {
  it('构造一个空快照', () => {
    const snapshot = emptyProjectSkillsSnapshot('/test')
    expect(snapshot.workspaceRoot).toBe('/test')
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })
})
