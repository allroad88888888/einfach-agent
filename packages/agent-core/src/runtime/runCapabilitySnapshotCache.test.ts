import { describe, expect, it, vi } from 'vitest'
import type { SkillsRegistry } from '../skills/contracts'
import type { SessionMeta } from '../state/core.type'
import type { Tool, ToolContext } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
import { buildStableModelPrefix } from './modelTurnPrefix'
import { createToolEpoch } from './toolEpoch'
import { capabilityToolRegistry } from './turnToolVisibility'

function tool(name: string, guide: string, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} description`, content: guide },
    inputSchema: { type: 'object', additionalProperties: false },
    execute,
  }
}

function registry(names: string[]): SkillsRegistry {
  return {
    list: () => names.map((name) => ({ name, description: `${name} description`, triggers: [] })),
    buildManifestText: () => [
      '可用 skills：',
      ...names.map((name) => `· ${name} — ${name} description`),
    ].join('\n'),
  }
}

function session(policy?: SessionMeta['capabilityPolicy']): SessionMeta {
  return {
    id: 'resume-session',
    title: 'resume session',
    settings: { vendor: 'deepseek', model: 'test-model' },
    createdAt: 0,
    updatedAt: 0,
    capabilityPolicy: policy,
  }
}

function locked(tools: string[]): SessionMeta['capabilityPolicy'] {
  return {
    version: 1,
    state: 'locked',
    revision: 1,
    allowedTools: tools,
    allowedSkills: ['planning'],
    lockedAt: 1,
  }
}

describe('run capability snapshots follow the ToolEpoch lifetime', () => {
  it('reuses restricted tool, Skill, and policy snapshots across the same epoch', async () => {
    const originalExecute = vi.fn(() => ({ ok: true as const }))
    const replacementExecute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ skillRegistry: registry([]) })
    core.tools.register(tool('same', 'old guide', originalExecute))
    const epoch = createToolEpoch(core.tools, { sessionId: 'resume-session', runId: 'run' })
    const first = await buildStableModelPrefix(session(locked(['late', 'same'])), core, epoch)
    const firstVersion = first.toolCatalog.registrationVersion('same')

    core.tools.register(tool('late', 'late guide', replacementExecute))
    core.tools.register(tool('same', 'replacement guide', replacementExecute))
    core.setSkillRegistry(registry(['planning']))
    const changedPolicy = locked(['drift', 'late', 'same'])
    const resumed = await buildStableModelPrefix(session(changedPolicy), core, epoch)

    expect(resumed.capabilities.allowsTool('drift')).toBe(false)
    expect(resumed.toolCatalog.loadSchema('late')).toBeUndefined()
    expect(resumed.toolCatalog.loadSchema('same')?.guide).toBe('old guide')
    expect(resumed.toolCatalog.registrationVersion('same')).toBe(firstVersion)
    expect(resumed.skills.summaries).toEqual([])
    expect(resumed.skillManifest.content).not.toContain('planning')
    const childRegistry = capabilityToolRegistry(core.tools, resumed.toolCatalog, resumed.capabilities)
    await expect(childRegistry.run('same', {}, {} as ToolContext)).resolves.toMatchObject({
      code: 'tool_unavailable_in_run',
    })
    expect(originalExecute).not.toHaveBeenCalled()
    expect(replacementExecute).not.toHaveBeenCalled()
  })

  it('does not cache legacy ToolEpoch or Skill registry behavior', async () => {
    const originalExecute = vi.fn(() => ({ ok: true as const }))
    const replacementExecute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ skillRegistry: registry([]) })
    core.tools.register(tool('same', 'old guide', originalExecute))
    const epoch = createToolEpoch(core.tools, { sessionId: 'resume-session', runId: 'legacy-run' })
    await buildStableModelPrefix(session(), core, epoch)

    core.tools.register(tool('late', 'late guide', replacementExecute))
    core.tools.register(tool('same', 'replacement guide', replacementExecute))
    core.setSkillRegistry(registry(['planning']))
    const resumed = await buildStableModelPrefix(session(), core, epoch)

    expect(resumed.toolCatalog).toBe(epoch)
    expect(resumed.toolCatalog.loadSchema('late')?.guide).toBe('late guide')
    expect(resumed.toolCatalog.loadSchema('same')?.guide).toBe('replacement guide')
    expect(resumed.skills.summaries.map((skill) => skill.name)).toEqual(['planning'])
    expect(resumed.skillManifest.content).toContain('planning')
    const childRegistry = capabilityToolRegistry(core.tools, resumed.toolCatalog, resumed.capabilities)
    await expect(childRegistry.run('same', {}, {} as ToolContext)).resolves.toMatchObject({ ok: true })
    expect(replacementExecute).toHaveBeenCalledOnce()
  })
})
