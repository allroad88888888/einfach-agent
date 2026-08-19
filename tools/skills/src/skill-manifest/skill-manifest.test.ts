import type { ProjectSkillsSnapshot } from '@einfach-agent/core/skills'
import { createToolRegistry } from '@einfach-agent/core/tools'
import type { ToolContext } from '@einfach-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { registerSkillsTools } from '../index'
import { buildSkillManifestText } from '../registry'
import { skillManifestTool } from './skill-manifest'

function makeCtx(ensure: () => Promise<ProjectSkillsSnapshot>): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(async (input) => ({
      platform: input.platform,
      shell: 'test',
      command: input.command,
      cwd: input.cwd ?? '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    })),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    projectSkills: { ensure },
  }
}

describe('tools/skill-manifest/skill-manifest', () => {
  it('以 sessionStart timed 工具注册，且不进入模型可见工具目录', () => {
    expect(skillManifestTool).toMatchObject({
      name: 'skill_manifest',
      runtime: 'internal',
      callTiming: 'sessionStart',
      inputSchema: { additionalProperties: false },
    })

    const registry = createToolRegistry()
    registerSkillsTools(registry)

    expect(registry.callTiming('skill_manifest')).toBe('sessionStart')
    expect(registry.list().some((tool) => tool.name === 'skill_manifest')).toBe(false)
    expect(registry.loadSchema('skill_manifest')).toBeUndefined()
  })

  it('调用实例 projectSkills.ensure，并逐字返回确保加载后的 L1 清单', async () => {
    const snapshot: ProjectSkillsSnapshot = {
      workspaceRoot: '/workspace',
      entries: [{
        name: 'project/deploy-flow',
        description: '何时用：发布前检查部署流程。',
        triggers: ['发布'],
        filePath: '.webAgent/skills/deploy-flow/SKILL.md',
        resources: {},
        origin: 'agent',
        scope: 'project',
        rootPath: '/workspace',
      }],
      diagnostics: [],
    }
    const ensure = vi.fn(async () => snapshot)

    const result = await skillManifestTool.execute({}, makeCtx(ensure))

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, data: buildSkillManifestText(snapshot) })
  })
})
