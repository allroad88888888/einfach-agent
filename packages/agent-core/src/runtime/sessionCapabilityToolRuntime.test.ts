import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '../tools/types'
import { sessionsAtom } from '../state/rootStore'
import { itemsAtom } from '../state/sessionAtoms'
import type { SessionCapabilityPolicy } from '../state/sessionCapabilityPolicy'
import { createCoreInstance } from './core/coreInstance'
import { runSession } from './modelRun'
import { buildToolContext } from './toolContext'
import {
  capabilityToolCatalog,
  captureRunCapabilitySnapshot,
  SESSION_TOOL_CAPABILITY_DENIED_CODE,
} from './turnToolVisibility'
import { buildToolManifestText, searchToolManifestPage } from './modelTurn'
import { jsonResponse, toolCallsResponse } from './modelRun.testHarness'
import { createToolEpoch } from './toolEpoch'

function locked(tools: string[], skills: string[] = []): SessionCapabilityPolicy {
  return {
    version: 1,
    state: 'locked',
    revision: 1,
    allowedTools: [...tools].sort(),
    allowedSkills: [...skills].sort(),
    lockedAt: 1,
  }
}

function tool(
  name: string,
  execute: Tool['execute'] = () => ({ ok: true }),
  guide = `${name} guide`,
): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} description`, content: guide },
    inputSchema: { type: 'object', additionalProperties: false },
    execute,
  }
}

function seed(
  core: ReturnType<typeof createCoreInstance>,
  id: string,
  capabilityPolicy?: SessionCapabilityPolicy,
): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'capability runtime',
      settings: { vendor: 'deepseek', model: 'test-model' },
      createdAt: 0,
      updatedAt: 0,
      capabilityPolicy,
    },
  })
}

describe('run capability tool views', () => {
  it.each([
    { label: 'locked allow', policy: locked(['allowed']), allowed: true },
    { label: 'locked deny', policy: locked([]), allowed: false },
    { label: 'legacy', policy: undefined, allowed: true },
    {
      label: 'unexpected draft fails closed',
      policy: { version: 1, state: 'draft', revision: 0, disabledTools: [], disabledSkills: [] } as SessionCapabilityPolicy,
      allowed: false,
    },
  ])('$label filters manifest, list, and schema consistently', ({ policy, allowed }) => {
    const core = createCoreInstance()
    core.tools.register(tool('allowed'))
    const snapshot = captureRunCapabilitySnapshot(policy)
    const catalog = capabilityToolCatalog(core.tools.snapshot(), snapshot)

    expect(buildToolManifestText(true, { registry: catalog }).includes('· allowed ')).toBe(allowed)
    expect(searchToolManifestPage({}, true, { registry: catalog })).toMatchObject({
      kind: 'tool_manifest_page',
      items: allowed ? expect.arrayContaining([expect.objectContaining({ name: 'allowed' })]) : expect.not.arrayContaining([expect.objectContaining({ name: 'allowed' })]),
    })
    expect(catalog.loadSchema('allowed') !== undefined).toBe(allowed)
  })

  it('freezes the epoch intersection so a newly registered allowed name stays absent', () => {
    const core = createCoreInstance()
    const capabilities = captureRunCapabilitySnapshot(locked(['late']))
    const epoch = createToolEpoch(core.tools, { sessionId: 'epoch', runId: 'run' })
    const catalog = capabilityToolCatalog(epoch, capabilities)

    core.tools.register(tool('late'))

    expect(epoch.loadSchema('late')).toBeDefined()
    expect(catalog.list()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'late' })]))
    expect(catalog.loadSchema('late')).toBeUndefined()
  })

  it('preserves ToolEpoch late admission and replacement following for legacy sessions', () => {
    const core = createCoreInstance()
    core.tools.register(tool('existing', undefined, 'old guide'))
    const epoch = createToolEpoch(core.tools, { sessionId: 'legacy', runId: 'run' })
    const catalog = capabilityToolCatalog(epoch, captureRunCapabilitySnapshot(undefined))

    core.tools.register(tool('late'))
    core.tools.register(tool('existing', undefined, 'replacement guide'))

    expect(catalog).toBe(epoch)
    expect(catalog.loadSchema('late')?.guide).toBe('late guide')
    expect(catalog.loadSchema('existing')?.guide).toBe('replacement guide')
    expect(catalog.registrationVersion('existing')).toBe(core.tools.registrationVersion('existing'))
  })

  it('does not observe policy object changes after capture', () => {
    const policy = locked(['alpha'])
    const snapshot = captureRunCapabilitySnapshot(policy)

    if (policy.state === 'locked') policy.allowedTools.push('beta')

    expect(snapshot.allowsTool('alpha')).toBe(true)
    expect(snapshot.allowsTool('beta')).toBe(false)
  })
})

describe('runtime tool execution enforcement', () => {
  it('bootstrap freezes late names and same-name replacements for a locked run', async () => {
    const core = createCoreInstance()
    const originalExecute = vi.fn(() => ({ ok: true as const }))
    const replacementExecute = vi.fn(() => ({ ok: true as const }))
    const lateExecute = vi.fn(() => ({ ok: true as const }))
    core.tools.register(tool('existing', originalExecute, 'old guide'))
    seed(core, 'bootstrap-frozen', locked(['existing', 'late']))
    const responses = [
      toolCallsResponse([{ id: 'late-schema', name: 'request_tool_schema', args: { toolName: 'late' } }]),
      toolCallsResponse([{ id: 'late-call', name: 'late', args: {} }]),
      toolCallsResponse([{ id: 'existing-schema', name: 'request_tool_schema', args: { toolName: 'existing' } }]),
      toolCallsResponse([{ id: 'existing-call', name: 'existing', args: {} }]),
      jsonResponse('done'),
    ]
    let request = 0
    const fetchImpl: typeof fetch = async () => {
      if (request === 0) {
        core.tools.register(tool('late', lateExecute))
        core.tools.register(tool('existing', replacementExecute, 'replacement guide'))
      }
      return responses[request++]
    }

    await runSession('bootstrap-frozen', 'run', {
      signal: new AbortController().signal, apiKey: 'test', fetchImpl, core,
    })

    const results = new Map(core.getSessionStore('bootstrap-frozen').store.getter(itemsAtom)
      .flatMap((entry) => entry.item.role === 'tool'
        ? [[entry.item.tool_call_id, JSON.parse(entry.item.content)] as const]
        : []))
    expect(results.get('late-schema')).toMatchObject({ error: 'unknown' })
    expect(results.get('late-call')).toMatchObject({ code: 'tool_schema_not_loaded' })
    expect(results.get('existing-schema')).toMatchObject({ loaded: true, guide: 'old guide' })
    expect(results.get('existing-call')).toMatchObject({
      error: expect.stringContaining('registration version mismatch'),
    })
    expect(originalExecute).not.toHaveBeenCalled()
    expect(replacementExecute).not.toHaveBeenCalled()
    expect(lateExecute).not.toHaveBeenCalled()
  })

  it('schema discovery/fetch and guessed top-level execution share the locked snapshot', async () => {
    const core = createCoreInstance()
    const deniedExecute = vi.fn(() => ({ ok: true as const }))
    const allowedExecute = vi.fn(() => ({ ok: true as const, data: { value: 'ok' } }))
    core.tools.register(tool('allowed_runtime_tool', allowedExecute))
    core.tools.register(tool('denied_runtime_tool', deniedExecute))
    seed(core, 'runtime', locked(['allowed_runtime_tool']))
    const responses = [
      toolCallsResponse([{ id: 'list', name: 'request_tool_schema', args: { reason: 'discover' } }]),
      toolCallsResponse([{ id: 'fetch-denied', name: 'request_tool_schema', args: { toolName: 'denied_runtime_tool', reason: 'guess' } }]),
      toolCallsResponse([{ id: 'call-denied', name: 'denied_runtime_tool', args: {} }]),
      toolCallsResponse([{ id: 'fetch-allowed', name: 'request_tool_schema', args: { toolName: 'allowed_runtime_tool', reason: 'use' } }]),
      toolCallsResponse([{ id: 'call-allowed', name: 'allowed_runtime_tool', args: {} }]),
      jsonResponse('done'),
    ]
    let request = 0
    const requestBodies: Array<{ messages?: Array<{ content?: string }> }> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return responses[request++]
    }

    await runSession('runtime', 'run', {
      signal: new AbortController().signal,
      apiKey: 'test',
      fetchImpl,
      core,
    })

    const prefixText = requestBodies[0].messages?.map((item) => item.content ?? '').join('\n') ?? ''
    expect(prefixText).toContain('allowed_runtime_tool')
    expect(prefixText).not.toContain('denied_runtime_tool')
    const toolResults = new Map(core.getSessionStore('runtime').store.getter(itemsAtom)
      .flatMap((entry) => entry.item.role === 'tool'
        ? [[entry.item.tool_call_id, JSON.parse(entry.item.content)] as const]
        : []))
    expect(JSON.stringify(toolResults.get('list'))).toContain('allowed_runtime_tool')
    expect(JSON.stringify(toolResults.get('list'))).not.toContain('denied_runtime_tool')
    expect(toolResults.get('fetch-denied')).toMatchObject({ code: SESSION_TOOL_CAPABILITY_DENIED_CODE })
    expect(toolResults.get('call-denied')).toMatchObject({ code: SESSION_TOOL_CAPABILITY_DENIED_CODE })
    expect(toolResults.get('fetch-allowed')).toMatchObject({ loaded: true, toolName: 'allowed_runtime_tool' })
    expect(deniedExecute).not.toHaveBeenCalled()
    expect(allowedExecute).toHaveBeenCalledOnce()
  })

  it('recursive callTool rejects a denied tool before execute without listing hidden names', async () => {
    const core = createCoreInstance()
    const innerExecute = vi.fn(() => ({ ok: true as const }))
    core.tools.register(tool('inner_denied', innerExecute))
    seed(core, 'recursive', locked(['outer_allowed']))
    const capabilitySnapshot = captureRunCapabilitySnapshot(locked(['outer_allowed']))
    const ctx = buildToolContext({
      sessionId: 'recursive',
      runId: 'run',
      signal: new AbortController().signal,
      callId: 'outer-call',
      toolName: 'outer_allowed',
      capabilitySnapshot,
      core,
    })

    const result = await ctx.callTool('inner_denied', {})

    expect(result).toMatchObject({ ok: false, code: SESSION_TOOL_CAPABILITY_DENIED_CODE })
    expect(JSON.stringify(result)).not.toContain('inner_denied')
    expect(innerExecute).not.toHaveBeenCalled()
  })

  it.each([
    { runtime: 'internal' as const, host: true, registerAfterSnapshot: true },
    { runtime: 'server' as const, host: false, registerAfterSnapshot: false },
  ])('recursive callTool also preserves registry/host upper bounds: $runtime', async ({
    runtime,
    host,
    registerAfterSnapshot,
  }) => {
    const core = createCoreInstance()
    const execute = vi.fn(() => ({ ok: true as const }))
    if (!registerAfterSnapshot) core.tools.register({ ...tool('bounded_tool', execute), runtime })
    seed(core, 'recursive-bounds', locked(['bounded_tool', 'outer_allowed']))
    const capabilities = captureRunCapabilitySnapshot(locked(['bounded_tool', 'outer_allowed']))
    const epoch = createToolEpoch(core.tools, { sessionId: 'recursive-bounds', runId: 'run' })
    const catalog = capabilityToolCatalog(epoch, capabilities)
    if (registerAfterSnapshot) core.tools.register({ ...tool('bounded_tool', execute), runtime })
    const ctx = buildToolContext({
      sessionId: 'recursive-bounds',
      runId: 'run',
      signal: new AbortController().signal,
      callId: 'outer-call',
      toolName: 'outer_allowed',
      capabilitySnapshot: capabilities,
      toolCatalog: catalog,
      hostHasLocalCapabilities: host,
      core,
    })

    await expect(ctx.callTool('bounded_tool', {})).resolves.toMatchObject({
      ok: false,
      code: 'tool_unavailable_in_run',
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
