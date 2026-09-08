import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolContext } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { SkillsRegistry } from '../skills/contracts'
import { sessionsAtom } from '../state/rootStore'
import { createTestScheduler } from '../subagents/runtime.scheduler.testFixtures'
import { subagentAllowedTools } from '../subagents/toolProfile'
import { createCoreInstance } from './core/coreInstance'
import { buildTurnTools } from './modelTurn'
import { runSession } from './modelRun'
import { jsonResponse } from './modelRun.testHarness'
import { buildToolContext } from './toolContext'
import {
  delegateRuntimeCapturing,
  runDelegation,
  seedSession,
} from './toolContext.workspaceRoot.testHarness'
import {
  capabilityToolCatalog,
  capabilityToolRegistry,
  captureRunCapabilitySnapshot,
  SESSION_TOOL_CAPABILITY_DENIED_CODE,
} from './turnToolVisibility'
import { createToolEpoch } from './toolEpoch'
import { captureRunSkillSnapshot } from './toolContext/skillsCapabilities'

function locked(tools: string[], skills: string[] = []) {
  return {
    version: 1 as const,
    state: 'locked' as const,
    revision: 1,
    allowedTools: [...tools].sort(),
    allowedSkills: [...skills].sort(),
    lockedAt: 1,
  }
}

function tool(name: string, runtime: Tool['runtime'], execute: Tool['execute']): Tool {
  return {
    name,
    runtime,
    skill: { description: name, content: `${name} guide` },
    inputSchema: { type: 'object', additionalProperties: false },
    execute,
  }
}

function setPolicy(
  core: ReturnType<typeof createCoreInstance>,
  sessionId: string,
  tools: string[],
): void {
  core.rootStore.setter(sessionsAtom, (sessions) => ({
    ...sessions,
    [sessionId]: { ...sessions[sessionId], capabilityPolicy: locked(tools) },
  }))
}

describe('session capability delegation intersection', () => {
  it('does not create a delegate runtime for a run that disables delegate_agent', async () => {
    const createRuntime = vi.fn()
    const core = createCoreInstance({
      delegation: () => ({ scheduler: createTestScheduler(), createRuntime }),
    })
    core.rootStore.setter(sessionsAtom, {
      disabled: {
        id: 'disabled', title: 'disabled', createdAt: 0, updatedAt: 0,
        settings: { vendor: 'deepseek', model: 'test-model' }, capabilityPolicy: locked([]),
      },
    })

    await runSession('disabled', 'run', {
      signal: new AbortController().signal,
      apiKey: 'test',
      fetchImpl: async () => jsonResponse('done'),
      core,
    })

    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('does not attach the top-level delegation surface when delegate_agent is disabled', () => {
    const core = createCoreInstance()
    seedSession('delegate-disabled', undefined, undefined, core)
    setPolicy(core, 'delegate-disabled', [])
    const ctx = buildToolContext({
      sessionId: 'delegate-disabled',
      runId: 'r',
      callId: 'delegate-call',
      toolName: 'delegate_agent',
      signal: new AbortController().signal,
      capabilitySnapshot: captureRunCapabilitySnapshot(locked([])),
      delegateRuntime: delegateRuntimeCapturing(async () => {}, 'delegate-disabled'),
      core,
    })

    expect(ctx.spawnAgents).toBeUndefined()
    expect(ctx.observeExecution).toBeUndefined()
  })

  it('runChildTool applies the session allowlist after the child profile', async () => {
    const core = createCoreInstance()
    const execute = vi.fn(() => ({ ok: true as const }))
    core.tools.register(tool('read_file', 'server', execute))
    core.tools.register(tool('skill_search', 'internal', execute))
    core.tools.register(tool('skill_read', 'internal', execute))
    seedSession('child-session-deny', '/workspace', undefined, core)
    setPolicy(core, 'child-session-deny', ['delegate_agent'])
    const childResults: unknown[] = []
    const ctx = buildToolContext({
      sessionId: 'child-session-deny',
      runId: 'r',
      callId: 'delegate-call',
      toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' },
      signal: new AbortController().signal,
      capabilitySnapshot: captureRunCapabilitySnapshot(locked(['delegate_agent'])),
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        childResults.push(await callContext.runChildTool?.('read_file', {}))
        childResults.push(await callContext.runChildTool?.('skill_search', {}))
        childResults.push(await callContext.runChildTool?.('skill_read', {}))
      }, 'child-session-deny'),
      core,
    })

    await runDelegation(ctx, {
      children: [{ objective: 'inspect' }],
      toolProfile: 'workspace_read',
    })

    expect(childResults[0]).toMatchObject({
      ok: false,
      code: SESSION_TOOL_CAPABILITY_DENIED_CODE,
    })
    expect(childResults.slice(1)).toEqual([
      { ok: false, error: 'tool not allowed for child agent: skill_search' },
      { ok: false, error: 'tool not allowed for child agent: skill_read' },
    ])
    expect(subagentAllowedTools('workspace_verify')).not.toEqual(
      expect.arrayContaining(['skill_search', 'skill_read']),
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes the frozen parent Skill subset to child tool executions', async () => {
    const skillRegistry: SkillsRegistry = {
      list: () => [{ name: 'planning', description: 'plan', triggers: [] }],
      buildManifestText: () => '',
    }
    const core = createCoreInstance({ skillRegistry })
    const capabilities = captureRunCapabilitySnapshot(locked(
      ['delegate_agent', 'read_file'], ['planning'],
    ))
    const skillSnapshot = captureRunSkillSnapshot(skillRegistry.list(), undefined, capabilities)
    let visibleSkills: string[] | undefined
    core.tools.register(tool('read_file', 'server', (_args, childCtx) => {
      visibleSkills = childCtx.skills?.list().map((skill) => skill.name)
      return { ok: true }
    }))
    seedSession('child-skills', '/workspace', undefined, core)
    setPolicy(core, 'child-skills', ['delegate_agent', 'read_file'])
    const ctx = buildToolContext({
      sessionId: 'child-skills', runId: 'r', callId: 'delegate-call', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' },
      signal: new AbortController().signal, capabilitySnapshot: capabilities, skillSnapshot,
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        await callContext.runChildTool?.('read_file', {})
      }, 'child-skills'), core,
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' })
    expect(visibleSkills).toEqual(['planning'])
  })

  it('runChildTool cannot execute a same-name replacement outside the run epoch', async () => {
    const core = createCoreInstance()
    const replacementExecute = vi.fn(() => ({ ok: true as const }))
    core.tools.register(tool('read_file', 'server', () => ({ ok: true as const })))
    const capabilities = captureRunCapabilitySnapshot(locked(['delegate_agent', 'read_file']))
    const epoch = createToolEpoch(core.tools, { sessionId: 'child-epoch', runId: 'r' })
    const toolCatalog = capabilityToolCatalog(epoch, capabilities)
    const runVersion = toolCatalog.registrationVersion('read_file')
    core.tools.register(tool('read_file', 'server', replacementExecute))
    seedSession('child-epoch', '/workspace', undefined, core)
    setPolicy(core, 'child-epoch', ['delegate_agent', 'read_file'])
    let childResult: unknown
    const ctx = buildToolContext({
      sessionId: 'child-epoch', runId: 'r', callId: 'delegate-call', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' },
      signal: new AbortController().signal,
      capabilitySnapshot: capabilities,
      toolCatalog,
      hostHasLocalCapabilities: true,
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        childResult = await callContext.runChildTool?.('read_file', {}, runVersion)
      }, 'child-epoch'),
      core,
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' })

    expect(childResult).toMatchObject({ ok: false })
    expect(replacementExecute).not.toHaveBeenCalled()
  })

  it('child discovery and execution intersect profile, host, registry epoch, and session policy', async () => {
    const core = createCoreInstance()
    const execute = () => ({ ok: true as const })
    core.tools.register(tool('delegate_agent', 'internal', execute))
    core.tools.register(tool('read_file', 'server', execute))
    core.tools.register(tool('session_denied', 'internal', execute))
    const capabilities = captureRunCapabilitySnapshot(locked(['delegate_agent', 'late', 'read_file']))
    const epoch = createToolEpoch(core.tools, { sessionId: 'child-discovery', runId: 'r' })
    const catalog = capabilityToolCatalog(epoch, capabilities)
    const runRegistry = capabilityToolRegistry(core.tools, catalog, capabilities)
    core.tools.register(tool('late', 'internal', execute))
    const visible = ['delegate_agent', 'read_file', 'session_denied']
      .flatMap((name) => runRegistry.loadSchema(name) ?? [])
    const profile = ['delegate_agent', 'read_file']

    expect(runRegistry.list().map((entry) => entry.name).sort()).toEqual([
      'delegate_agent',
      'read_file',
    ])
    await expect(runRegistry.run('late', {}, {} as ToolContext)).resolves.toMatchObject({
      ok: false,
      code: 'tool_unavailable_in_run',
    })
    expect(buildTurnTools(visible, false, {
      registry: runRegistry,
      allowedToolNames: profile,
    }).map((entry) => entry.function.name)).toEqual([
      'request_tool_schema',
      'delegate_agent',
    ])
    expect(buildTurnTools(visible, true, {
      registry: runRegistry,
      allowedToolNames: ['delegate_agent'],
    }).map((entry) => entry.function.name)).toEqual([
      'request_tool_schema',
      'delegate_agent',
    ])
  })

  it('bootstrap gives delegation the same strict catalog captured for the parent run', async () => {
    let childRegistry: ToolRegistry | undefined
    const replacementExecute = vi.fn(() => ({ ok: true as const }))
    const lateExecute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({
      delegation: () => ({
        scheduler: createTestScheduler(),
        createRuntime: async (input) => {
          childRegistry = input.registry
          return delegateRuntimeCapturing(async () => {}, 'delegation-bootstrap')
        },
      }),
    })
    core.tools.register(tool('delegate_agent', 'internal', () => ({ ok: true as const })))
    core.tools.register(tool('read_file', 'server', () => ({ ok: true as const })))
    core.rootStore.setter(sessionsAtom, {
      'delegation-bootstrap': {
        id: 'delegation-bootstrap', title: 'delegation bootstrap', createdAt: 0, updatedAt: 0,
        settings: { vendor: 'deepseek', model: 'test-model' },
        capabilityPolicy: locked(['delegate_agent', 'late', 'read_file']),
      },
    })

    await runSession('delegation-bootstrap', 'run', {
      signal: new AbortController().signal,
      apiKey: 'test',
      fetchImpl: async () => {
        core.tools.register(tool('late', 'internal', lateExecute))
        core.tools.register(tool('read_file', 'server', replacementExecute))
        return jsonResponse('done')
      },
      core,
    })

    expect(childRegistry).toBeDefined()
    const registry = childRegistry!
    expect(registry.loadSchema('late')).toBeUndefined()
    await expect(registry.run('late', {}, {} as ToolContext)).resolves.toMatchObject({
      code: 'tool_unavailable_in_run',
    })
    await expect(registry.run('read_file', {}, {} as ToolContext)).resolves.toMatchObject({
      code: 'tool_unavailable_in_run',
    })
    expect(lateExecute).not.toHaveBeenCalled()
    expect(replacementExecute).not.toHaveBeenCalled()
  })
})
