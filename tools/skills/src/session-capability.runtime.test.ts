import { describe, expect, it } from 'vitest'
import type { SkillsRegistry } from '@einfach-agent/core/skills'
import type { SessionMeta } from '@einfach-agent/core/state/core.type'
import {
  disabledProjectSkillsByWorkspaceAtom,
  sessionsAtom,
  workspacesAtom,
} from '@einfach-agent/core/state/rootStore'
import { createCoreInstance } from '@einfach-agent/core/runtime/core/coreInstance'
import { buildStableModelPrefix } from '@einfach-agent/core/runtime/modelTurnPrefix'
import { buildToolContext } from '@einfach-agent/core/runtime/toolContext'
import { createToolEpoch } from '@einfach-agent/core/runtime/toolEpoch'
import { skillReadTool } from './skill-read/skill-read'
import { skillSearchTool } from './skill-search/skill-search'

const limitedRegistry: SkillsRegistry = {
  list: () => [{
    name: 'ask-user-question',
    description: 'available',
    triggers: [],
  }],
  buildManifestText: () => 'custom manifest',
}

const meta: SessionMeta = {
  id: 'skill-membership',
  title: 'skill membership',
  settings: { vendor: 'deepseek', model: 'test-model' },
  createdAt: 0,
  updatedAt: 0,
  workspaceId: 'workspace',
  capabilityPolicy: {
    version: 1,
    state: 'locked',
    revision: 1,
    allowedTools: [],
    allowedSkills: [
      'ask-user-question',
      'planning',
      'project/workspace-disabled',
      'user/missing',
    ],
    lockedAt: 1,
  },
}

describe('Skill tools use the runtime snapshot membership', () => {
  it('denies global built-ins and scanned names absent from the run snapshot', async () => {
    const core = createCoreInstance({
      skillRegistry: limitedRegistry,
      projectSkillsProvider: async () => ({
        workspaceRoot: '/workspace',
        entries: [{
          name: 'project/workspace-disabled',
          description: 'disabled project skill',
          triggers: [],
          rootPath: '/workspace',
          filePath: '.webAgent/skills/disabled/SKILL.md',
          resources: {},
          origin: 'agent',
          scope: 'project',
        }],
        diagnostics: [],
      }),
    })
    core.rootStore.setter(sessionsAtom, { [meta.id]: meta })
    core.rootStore.setter(workspacesAtom, {
      workspace: {
        id: 'workspace', name: 'workspace', rootPath: '/workspace', createdAt: 0, updatedAt: 0,
      },
    })
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      workspace: ['project/workspace-disabled'],
    })
    const epoch = createToolEpoch(core.tools, { sessionId: meta.id, runId: 'run' })
    await buildStableModelPrefix(meta, core, epoch)
    core.setSkillRegistry({
      list: () => [
        ...limitedRegistry.list(),
        { name: 'planning', description: 'late planning', triggers: [] },
      ],
      buildManifestText: () => 'custom manifest with late planning',
    })
    const prefix = await buildStableModelPrefix(meta, core, epoch)
    const ctx = buildToolContext({
      sessionId: meta.id,
      runId: 'run',
      callId: 'skill-call',
      toolName: 'skill_read',
      signal: new AbortController().signal,
      capabilitySnapshot: prefix.capabilities,
      skillSnapshot: prefix.skills,
      core,
    })

    expect(prefix.skills.summaries.map((skill) => skill.name)).toEqual(['ask-user-question'])
    for (const name of ['planning', 'project/workspace-disabled', 'user/missing']) {
      expect(ctx.skills?.isAllowed(name)).toBe(false)
      const search = await skillSearchTool.execute({ query: name }, ctx)
      expect(search).toMatchObject({ ok: true })
      const resultNames = (search as { data: { results: Array<{ name: string }> } })
        .data.results.map((result) => result.name)
      expect(resultNames).not.toContain(name)
      expect(resultNames.every((resultName) => resultName === 'ask-user-question')).toBe(true)
      for (const resource of [undefined, 'references/evaluation.md']) {
        const read = await skillReadTool.execute({ name, ...(resource ? { resource } : {}) }, ctx)
        expect(read).toMatchObject({ ok: false, code: 'SKILL_NOT_FOUND' })
        expect(JSON.stringify(read)).not.toContain(name)
      }
    }
  })

  it('keeps global built-in lookup behavior for a legacy-unrestricted context', async () => {
    const core = createCoreInstance({ skillRegistry: limitedRegistry })
    const legacy: SessionMeta = {
      id: 'legacy-skills',
      title: 'legacy skills',
      settings: { vendor: 'deepseek', model: 'test-model' },
      createdAt: 0,
      updatedAt: 0,
    }
    core.rootStore.setter(sessionsAtom, { [legacy.id]: legacy })
    const prefix = await buildStableModelPrefix(legacy, core)
    const ctx = buildToolContext({
      sessionId: legacy.id,
      runId: 'run',
      callId: 'skill-call',
      toolName: 'skill_read',
      signal: new AbortController().signal,
      capabilitySnapshot: prefix.capabilities,
      skillSnapshot: prefix.skills,
      core,
    })

    expect(ctx.skills?.isAllowed('planning')).toBe(true)
    await expect(skillReadTool.execute({ name: 'planning' }, ctx)).resolves.toMatchObject({
      ok: true,
      data: { name: 'planning' },
    })
  })
})
