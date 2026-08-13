import { describe, expect, it } from 'vitest'
import type { ProjectSkillsSnapshot } from './projectSkills'
import {
  filterProjectSkillsSnapshot,
  normalizeDisabledProjectSkills,
  setProjectSkillEnabled,
} from './projectSkillPreferences'

const snapshot: ProjectSkillsSnapshot = {
  workspaceRoot: '/workspace',
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
  diagnostics: ['scanner notice'],
}

describe('project skill preferences', () => {
  it('normalizes persisted disabled names and drops malformed entries', () => {
    expect(normalizeDisabledProjectSkills({
      second: ['project/zebra', 'project/zebra', 'invalid/name'],
      first: ['project/alpha', 42],
      malformed: 'project/not-an-array',
    })).toEqual({
      first: ['project/alpha'],
      second: ['project/zebra'],
    })
  })

  it('stores only disabled names, so removing the last name restores the default enabled state', () => {
    const disabled = setProjectSkillEnabled({}, 'workspace-1', 'project/release-check', false)
    expect(disabled).toEqual({ 'workspace-1': ['project/release-check'] })

    expect(setProjectSkillEnabled(disabled, 'workspace-1', 'project/release-check', true)).toEqual({})
  })

  it('filters a runtime snapshot without mutating the cached scan result', () => {
    const filtered = filterProjectSkillsSnapshot(snapshot, ['project/release-check'])

    expect(filtered).toEqual({ ...snapshot, entries: [snapshot.entries[1]] })
    expect(snapshot.entries).toHaveLength(2)
    expect(filterProjectSkillsSnapshot(snapshot, [])).toBe(snapshot)
  })
})
