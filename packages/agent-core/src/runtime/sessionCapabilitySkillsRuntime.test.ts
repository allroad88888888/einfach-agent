import { describe, expect, it } from 'vitest'
import type { SkillsRegistry } from '../skills/contracts'
import type { ProjectSkillEntry, ProjectSkillsSnapshot } from '../skills/projectSkills'
import type { SessionMeta } from '../state/core.type'
import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { createCoreInstance } from './core/coreInstance'
import { buildStableModelPrefix } from './modelTurnPrefix'
import { buildToolContext } from './toolContext'

function entry(name: string, scope: 'project' | 'user'): ProjectSkillEntry {
  return {
    name,
    description: `${name} description`,
    triggers: [],
    rootPath: scope === 'project' ? '/workspace' : '/home/user',
    filePath: `${name}/SKILL.md`,
    resources: {},
    origin: 'agent',
    scope,
  }
}

function registry(names: readonly string[]): SkillsRegistry {
  return {
    list: () => names.map((name) => ({ name, description: `${name} description`, triggers: [] })),
    buildManifestText: (projectSkills) => [
      '可用 skills：',
      ...names.map((name) => `· ${name} — ${name} description`),
      ...(projectSkills?.entries ?? []).map((skill) => `· ${skill.name} — ${skill.description}`),
      'registry prose must not leak web-chat-agent',
    ].join('\n'),
  }
}

function session(policy: SessionMeta['capabilityPolicy']): SessionMeta {
  return {
    id: 'skills-session',
    title: 'skills runtime',
    settings: { vendor: 'deepseek', model: 'test-model' },
    createdAt: 0,
    updatedAt: 0,
    workspaceId: 'workspace',
    capabilityPolicy: policy,
  }
}

describe('run capability Skill snapshot', () => {
  it('uses one allowed set for built-in/project/user manifest, list, and resolution', async () => {
    const projectSnapshot: ProjectSkillsSnapshot = {
      workspaceRoot: '/workspace',
      userSkillsRoot: '/home/user',
      entries: [
        entry('project/release', 'project'),
        entry('project/workspace-disabled', 'project'),
        entry('user/notes', 'user'),
      ],
      diagnostics: [],
    }
    const core = createCoreInstance({
      skillRegistry: registry(['planning', 'web-chat-agent']),
      projectSkillsProvider: async () => projectSnapshot,
    })
    const meta = session({
      version: 1,
      state: 'locked',
      revision: 1,
      allowedTools: [],
      allowedSkills: ['planning', 'project/release', 'project/workspace-disabled'],
      lockedAt: 1,
    })
    core.rootStore.setter(sessionsAtom, { [meta.id]: meta })
    core.rootStore.setter(workspacesAtom, {
      workspace: { id: 'workspace', name: 'workspace', rootPath: '/workspace', createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      workspace: ['project/workspace-disabled'],
    })

    const prefix = await buildStableModelPrefix(meta, core)
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

    expect(prefix.skillManifest.content).toContain('· planning —')
    expect(prefix.skillManifest.content).toContain('· project/release —')
    expect(prefix.skillManifest.content).not.toContain('web-chat-agent')
    expect(prefix.skillManifest.content).not.toContain('registry prose')
    expect(prefix.skillManifest.content).not.toContain('user/notes')
    expect(prefix.skillManifest.content).not.toContain('project/workspace-disabled')
    expect(ctx.skills?.list().map((skill) => skill.name)).toEqual(['planning', 'project/release'])
    expect(ctx.skills?.resolveScannedSkill('project/release')).toMatchObject({
      filePath: 'project/release/SKILL.md',
    })
    expect(ctx.skills?.resolveScannedSkill('user/notes')).toBeUndefined()
  })

  it('registry changes after prefix capture cannot add a Skill to the current run', async () => {
    const core = createCoreInstance({ skillRegistry: registry(['planning']) })
    const meta = session({
      version: 1,
      state: 'locked',
      revision: 1,
      allowedTools: [],
      allowedSkills: ['late', 'planning'],
      lockedAt: 1,
    })
    const prefix = await buildStableModelPrefix(meta, core)
    core.setSkillRegistry(registry(['late', 'planning']))
    const ctx = buildToolContext({
      sessionId: meta.id,
      runId: 'run',
      callId: 'skill-call',
      toolName: 'skill_search',
      signal: new AbortController().signal,
      capabilitySnapshot: prefix.capabilities,
      skillSnapshot: prefix.skills,
      core,
    })

    expect(ctx.skills?.list().map((skill) => skill.name)).toEqual(['planning'])
  })

  it('an unexpected draft exposes no Skill', async () => {
    const core = createCoreInstance({ skillRegistry: registry(['planning']) })
    const prefix = await buildStableModelPrefix(session({
      version: 1,
      state: 'draft',
      revision: 0,
      disabledTools: [],
      disabledSkills: [],
    }), core)

    expect(prefix.skills.summaries).toEqual([])
    expect(prefix.skillManifest.content).not.toContain('· planning —')
  })
})
