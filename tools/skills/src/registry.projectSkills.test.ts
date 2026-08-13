import type {
  ProjectSkillEntry,
  ProjectSkillsSnapshot,
} from '@web-agent/core/skills'
import { describe, expect, it } from 'vitest'
import { buildSkillManifestText } from './registry'

const baselineManifest = buildSkillManifestText()

describe('buildSkillManifestText 项目段', () => {
  function makeSnapshot(entries: ProjectSkillEntry[]): ProjectSkillsSnapshot {
    return {
      workspaceRoot: '/test',
      entries,
      diagnostics: [],
    }
  }

  it('无参调用 → 与基线逐字相同（web 端零回归）', () => {
    const current = buildSkillManifestText()
    expect(current).toBe(baselineManifest)
  })

  it('undefined 入参 → 与基线逐字相同', () => {
    expect(buildSkillManifestText(undefined)).toBe(baselineManifest)
  })

  it('空快照 → 与基线逐字相同', () => {
    expect(buildSkillManifestText(makeSnapshot([]))).toBe(baselineManifest)
  })

  it('有空快照两次调用一致（字节稳定）', () => {
    const a = buildSkillManifestText(makeSnapshot([]))
    const b = buildSkillManifestText(makeSnapshot([]))
    expect(a).toBe(b)
  })

  it('带项目 skill 的快照 → 出现项目段', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/deploy-flow',
      description: '何时用：改发布脚本时读我；何时不用：普通改动',
      triggers: [],
      filePath: '.webAgent/skills/deploy-flow/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const manifest = buildSkillManifestText(makeSnapshot([entry]))
    expect(manifest).toContain('以下由当前 workspace 提供')
    expect(manifest).toContain('project/deploy-flow')
    // 依然包含抬头和内置 skills
    expect(manifest).toContain('skill_read')
    expect(manifest).toContain('planning')
  })

  it('项目段在内置段之后', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/test',
      description: '测试 skill',
      triggers: [],
      filePath: '.webAgent/skills/test/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const manifest = buildSkillManifestText(makeSnapshot([entry]))
    const projectIndex = manifest.indexOf('以下由当前 workspace 提供')
    const builtinIndex = manifest.indexOf('skill_read')
    expect(projectIndex).toBeGreaterThan(builtinIndex)
  })

  it('多个项目 skill 按名字字节序排列', () => {
    const entries: ProjectSkillEntry[] = [
      {
        name: 'project/zebra',
        description: 'z desc',
        triggers: [],
        filePath: '.webAgent/skills/zebra/SKILL.md',
        resources: {},
        origin: 'agent',
      },
      {
        name: 'project/alpha',
        description: 'a desc',
        triggers: [],
        filePath: '.webAgent/skills/alpha/SKILL.md',
        resources: {},
        origin: 'agent',
      },
    ]
    const manifest = buildSkillManifestText(makeSnapshot(entries))
    const lines = manifest.split('\n')
    const projectSectionStart = lines.findIndex((l) => l.includes('以下由当前 workspace'))
    const projectLines = lines.slice(projectSectionStart + 1)
    // alpha 应该在 zebra 之前
    expect(projectLines[0]).toContain('project/alpha')
    expect(projectLines[1]).toContain('project/zebra')
  })

  it('有项目段时两次调用一致', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/test',
      description: '测试 skill',
      triggers: [],
      filePath: '.webAgent/skills/test/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const snapshot = makeSnapshot([entry])
    expect(buildSkillManifestText(snapshot)).toBe(buildSkillManifestText(snapshot))
  })
})
