import { afterEach, describe, expect, it } from 'vitest'
import type { Tool } from '../tools/types'
import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom, workspacesAtom } from '../state/rootAtoms'
import { createCoreInstance } from './core/coreInstance'
import { configureHostInvoke } from './hostBridge'
import { resolveSessionCapabilityCatalog } from './sessionCapabilityCatalog'

function tool(name: string, runtime: Tool['runtime'] = 'internal'): Tool {
  return {
    name,
    runtime,
    skill: { description: `${name} description`, content: `${name} guide` },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

function seededCore(policy?: Parameters<typeof seedSession>[1]) {
  const core = createCoreInstance({
    skillRegistry: {
      list: () => [
        { name: 'builtin-z', description: 'Built in Z', triggers: [] },
        { name: 'builtin-a', description: 'Built in A', triggers: [] },
      ],
      buildManifestText: () => '',
    },
    projectSkillsProvider: async (workspaceRoot) => ({
      workspaceRoot,
      entries: [{
        name: 'project/release',
        description: 'Release project',
        triggers: [],
        rootPath: workspaceRoot,
        filePath: '.webAgent/skills/release/SKILL.md',
        resources: {},
        origin: 'agent',
        scope: 'project',
      }],
      diagnostics: [],
    }),
  })
  core.tools.register(tool('beta'))
  core.tools.register(tool('alpha'))
  core.tools.register(tool('server-only', 'server'))
  core.tools.register(tool('skill_search'))
  core.tools.register(tool('skill_read'))
  seedSession(core, policy)
  return core
}

function seedSession(
  core: ReturnType<typeof createCoreInstance>,
  capabilityPolicy?: {
    version: 1
    state: 'locked'
    revision: number
    allowedTools: string[]
    allowedSkills: string[]
    lockedAt: number
  },
): void {
  core.rootStore.setter(workspacesAtom, {
    workspace: { id: 'workspace', name: 'Workspace', rootPath: '/workspace', createdAt: 1, updatedAt: 1 },
  })
  core.rootStore.setter(sessionsAtom, {
    session: {
      id: 'session',
      title: 'Session',
      settings: { vendor: 'test', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
      workspaceId: 'workspace',
      ...(capabilityPolicy ? { capabilityPolicy } : {}),
    },
  })
}

afterEach(() => configureHostInvoke(undefined))

describe('session capability catalog', () => {
  it('applies registry trust, host capability, and workspace skill preference ceilings', async () => {
    const core = seededCore()
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      workspace: ['project/release'],
    })

    const catalog = await resolveSessionCapabilityCatalog(core, 'session')

    expect(catalog?.state).toBe('legacy-unrestricted')
    expect(catalog?.tools.map((item) => item.name)).toEqual(['alpha', 'beta'])
    expect(catalog?.skills.map((item) => item.name)).toEqual(['builtin-a', 'builtin-z'])
    expect(catalog?.tools.every((item) => item.available && item.selected)).toBe(true)
  })

  it('returns locked allowlist tombstones as selected unavailable items', async () => {
    const core = seededCore({
      version: 1,
      state: 'locked',
      revision: 2,
      allowedTools: ['alpha', 'removed-tool'],
      allowedSkills: ['removed-skill'],
      lockedAt: 20,
    })

    const catalog = await resolveSessionCapabilityCatalog(core, 'session')

    expect(catalog?.tools).toEqual([
      expect.objectContaining({ name: 'alpha', available: true, selected: true }),
      expect.objectContaining({ name: 'beta', available: true, selected: false }),
      expect.objectContaining({
        name: 'removed-tool', available: false, selected: true, description: '',
      }),
    ])
    expect(catalog?.skills).toContainEqual(
      expect.objectContaining({
        name: 'removed-skill', available: false, selected: true, description: '',
      }),
    )
  })

  it('includes server tools only while the host bridge is configured', async () => {
    const core = seededCore()
    configureHostInvoke({ loader: async () => async <T>() => ({}) as T, platform: 'linux' })

    const catalog = await resolveSessionCapabilityCatalog(core, 'session')

    expect(catalog?.tools.map((item) => item.name)).toContain('server-only')
  })
})
