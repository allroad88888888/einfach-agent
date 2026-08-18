import type { ProjectSkillEntry } from './projectSkills'
import {
  emptyProjectSkillsSnapshot,
  MAX_PROJECT_SKILLS,
  resolveProjectSkills,
} from './projectSkills'
import { describe, expect, it } from 'vitest'

describe('resolveProjectSkills', () => {
  function makeEntry(name: string, origin: 'agent' | 'claude' = 'agent'): ProjectSkillEntry {
    return {
      name: `project/${name}`,
      description: `description for ${name}`,
      triggers: [],
      filePath: origin === 'agent' ? `.webAgent/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`,
      resources: {},
      origin,
    }
  }

  it('空输入 → 空快照', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [],
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.workspaceRoot).toBe('/test')
  })

  it('.webAgent 与 .claude 撞名 → .webAgent 胜', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [makeEntry('deploy', 'agent')],
      agentDiagnostics: [],
      claudeEntries: [makeEntry('deploy', 'claude')],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].origin).toBe('agent')
    expect(snapshot.diagnostics.some((d) => d.includes('.webAgent 同名') && d.includes('claude'))).toBe(true)
  })

  it('不撞名时两路合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [makeEntry('deploy', 'agent')],
      agentDiagnostics: [],
      claudeEntries: [makeEntry('legacy', 'claude')],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(2)
  })

  it('按名字字节序排序', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [
        makeEntry('zebra', 'agent'),
        makeEntry('alpha', 'agent'),
        makeEntry('mike', 'claude'),
      ],
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    const names = snapshot.entries.map((e) => e.name)
    expect(names).toEqual(['project/alpha', 'project/mike', 'project/zebra'])
  })

  it('超过 MAX_PROJECT_SKILLS 截断', () => {
    const entries = Array.from({ length: MAX_PROJECT_SKILLS + 5 }, (_, i) =>
      makeEntry(`skill-${String(i).padStart(3, '0')}`, 'agent'),
    )
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: entries,
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(MAX_PROJECT_SKILLS)
    expect(snapshot.diagnostics.some((d) => d.includes('超过上限'))).toBe(true)
  })

  it('diagnostics 合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [],
      agentDiagnostics: ['agent warning'],
      claudeEntries: [],
      claudeDiagnostics: ['claude warning'],
    })
    expect(snapshot.diagnostics).toContain('agent warning')
    expect(snapshot.diagnostics).toContain('claude warning')
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
