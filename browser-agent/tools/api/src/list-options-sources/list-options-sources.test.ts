import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, type ToolContext } from '@einfach-agent/core/tools'
import { createApiToolsHost, type ApiCallContext, type ApiToolsHost, type OptionsSource } from '../options-host'
import { createListOptionsSourcesTool } from './list-options-sources'
import { registerApiTools } from '../query-options/query-options'

function context(sessionId = 'a', signal = new AbortController().signal): ToolContext {
  return { sessionId, signal, progress: vi.fn(), callTool: vi.fn(), runShell: vi.fn(), renderCard: vi.fn(), saveArtifact: vi.fn() } as unknown as ToolContext
}

function apiContext(sessionId = 'a', signal = new AbortController().signal): ApiCallContext {
  return { sessionId, signal }
}

const sources: OptionsSource[] = [
  { id: 'cities', label: 'Cities', description: 'Approved city choices', query: vi.fn(async () => ({ options: [{ label: 'Paris', value: 'paris' }] })) },
  { id: 'people', label: 'People', query: vi.fn(async () => ({ options: [] })) },
  { id: 'private', label: 'P'.repeat(501), description: 'D'.repeat(501), query: vi.fn(async () => ({ options: [] })) },
]

describe('list_options_sources tool', () => {
  it('discovers the current session sources then queries one through the registry', async () => {
    const host = createApiToolsHost(sources, { isSourceAllowed: (id, session) => session === 'a' && id !== 'private' })
    const registry = createToolRegistry()
    registerApiTools(registry, host)
    await expect(registry.run('list_options_sources', {}, context())).resolves.toEqual({
      ok: true,
      data: { sources: [{ id: 'cities', label: 'Cities', description: 'Approved city choices' }, { id: 'people', label: 'People' }] },
    })
    await expect(registry.run('query_options', { sourceId: 'cities' }, context())).resolves.toMatchObject({ ok: true, data: { options: [{ label: 'Paris', value: 'paris' }] } })
  })

  it('filters before paginating and reflects permission changes for every call', async () => {
    const allowed = new Set(['cities', 'people'])
    const host = createApiToolsHost(sources, { isSourceAllowed: (id) => allowed.has(id) })
    await expect(host.listSources?.({ offset: 1, limit: 1 }, apiContext())).resolves.toEqual({ sources: [{ id: 'people', label: 'People' }] })
    allowed.delete('people'); allowed.add('private')
    await expect(host.listSources?.({}, apiContext())).resolves.toEqual({ sources: [{ id: 'cities', label: 'Cities', description: 'Approved city choices' }, { id: 'private' }] })
  })

  it('uses only registered sources and exposes no adapter properties', async () => {
    const registered: OptionsSource[] = [{ id: 'safe', label: 'Safe', query: async () => ({ options: [] }) }]
    const host = createApiToolsHost(registered, { isSourceAllowed: () => true })
    registered.push({ id: 'injected', label: 'Injected', query: async () => ({ options: [] }) })
    ;(registered[0] as OptionsSource & { headers: string; request: string }).headers = 'Bearer secret'
    ;(registered[0] as OptionsSource & { headers: string; request: string }).request = 'https://private.example'
    const result = await host.listSources?.({}, apiContext())
    expect(result).toEqual({ sources: [{ id: 'safe', label: 'Safe' }] })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|headers|request/)
  })

  it('returns empty authorized lists, never runs a source query, and limits metadata', async () => {
    const query = vi.fn(async () => ({ options: [] }))
    const host = createApiToolsHost([{ id: 'hidden', label: 'visible name', query }], { isSourceAllowed: () => false })
    await expect(host.listSources?.({}, apiContext())).resolves.toEqual({ sources: [] })
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects cancelled and invalid direct calls without exposing permission errors', async () => {
    const controller = new AbortController(); controller.abort()
    const host = createApiToolsHost(sources, { isSourceAllowed: () => { throw new Error('Bearer private-token') } })
    await expect(host.listSources?.({}, apiContext('a', controller.signal))).rejects.toMatchObject({ code: 'API_OPTIONS_CANCELLED' })
    for (const input of [1, [], null, { offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: -1 }, { limit: 101 }, { limit: 1.5 }, { limit: '1' }]) {
      await expect(host.listSources?.(input as never, apiContext())).rejects.toMatchObject({ code: 'API_OPTIONS_INVALID_INPUT' })
    }
    await expect(host.listSources?.({}, apiContext())).rejects.toMatchObject({ code: 'API_OPTIONS_FORBIDDEN' })
  })

  it('maps invalid schema arguments and permission failures to fixed tool errors', async () => {
    const host = createApiToolsHost(sources, { isSourceAllowed: () => { throw new Error('secret authorization header') } })
    const tool = createListOptionsSourcesTool(host)
    const registry = createToolRegistry(); registry.register(tool)
    await expect(registry.run('list_options_sources', { limit: 101 }, context())).resolves.toMatchObject({ ok: false })
    await expect(registry.run('list_options_sources', { offset: Number.MAX_SAFE_INTEGER + 1 }, context())).resolves.toMatchObject({ ok: false })
    const result = await registry.run('list_options_sources', {}, context())
    expect(result).toEqual({ ok: false, error: 'options source is not allowed for this session', code: 'API_OPTIONS_FORBIDDEN', retryable: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('keeps session authorization isolated', async () => {
    const host = createApiToolsHost(sources, { isSourceAllowed: (id, session) => session === 'a' ? id === 'cities' : id === 'people' })
    await expect(host.listSources?.({}, apiContext('a'))).resolves.toEqual({ sources: [{ id: 'cities', label: 'Cities', description: 'Approved city choices' }] })
    await expect(host.listSources?.({}, apiContext('b'))).resolves.toEqual({ sources: [{ id: 'people', label: 'People' }] })
  })

  it('keeps legacy hosts that implement only queryOptions compatible', () => {
    const legacy: ApiToolsHost = { queryOptions: async () => ({ options: [] }) }
    const registry = createToolRegistry()
    registerApiTools(registry, legacy)
    expect(registry.list().map((tool) => tool.name)).toEqual(['query_options'])
  })
})
