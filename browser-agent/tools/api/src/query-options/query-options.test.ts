import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, type ToolContext } from '@einfach-agent/core/tools'
import { createFetchOptionsSource } from '../fetch-options-source'
import { ApiToolsError, createApiToolsHost, type OptionsSource } from '../options-host'
import { registerApiTools } from './query-options'

function context(signal = new AbortController().signal): ToolContext {
  return { sessionId: 'session-a', signal, progress: vi.fn(), callTool: vi.fn(), runShell: vi.fn(), renderCard: vi.fn(), saveArtifact: vi.fn() } as unknown as ToolContext
}

function registryWithSource(
  fetch: Parameters<typeof createFetchOptionsSource>[0]['fetch'],
  timeoutMs?: number,
) {
  const source = createFetchOptionsSource({
    id: 'people',
    fetch,
    request: (input) => ({ url: `https://example.test/people?q=${input.query ?? ''}`, init: { headers: { Authorization: 'Bearer secret-key' } } }),
    mapResponse: (payload) => {
      const body = payload as { items?: Array<{ display: string; id: string }>; cursor?: string }
      return { options: (body.items ?? []).map(({ display, id }) => ({ label: display, value: id })), nextCursor: body.cursor }
    },
  })
  const registry = createToolRegistry()
  registerApiTools(registry, createApiToolsHost([source], { isSourceAllowed: () => true, timeoutMs }))
  return registry
}

describe('query_options tool', () => {
  it('registers independently and returns mapped label/value candidates', async () => {
    const registry = registryWithSource(vi.fn(async () => new Response(JSON.stringify({ items: [{ display: 'Ada', id: 'u1' }], cursor: 'n2' }), { status: 200 })))
    await expect(registry.run('query_options', { sourceId: 'people', query: 'Ada' }, context())).resolves.toEqual({ ok: true, data: { options: [{ label: 'Ada', value: 'u1' }], nextCursor: 'n2' } })
  })

  it.each([[401, 'API_OPTIONS_UNAUTHORIZED'], [429, 'API_OPTIONS_RATE_LIMITED'], [500, 'API_OPTIONS_SERVICE_ERROR'], [504, 'API_OPTIONS_TIMEOUT']])('classifies HTTP %i without leaking credentials or response body', async (status, code) => {
    const registry = registryWithSource(vi.fn(async () => new Response('server says Bearer secret-key', { status })))
    const result = await registry.run('query_options', { sourceId: 'people' }, context())
    expect(result).toMatchObject({ ok: false, code })
    expect(JSON.stringify(result)).not.toContain('secret-key')
  })

  it('classifies non-JSON, malformed mapped data, and cancellation without exposing response data', async () => {
    const nonJson = registryWithSource(vi.fn(async () => new Response('private raw response', { status: 200 })))
    await expect(nonJson.run('query_options', { sourceId: 'people' }, context())).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_INVALID_RESPONSE' })
    const malformed = registryWithSource(vi.fn(async () => new Response(JSON.stringify({ items: [{ display: 'Ada', id: 3 }] }), { status: 200 })))
    await expect(malformed.run('query_options', { sourceId: 'people' }, context())).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_INVALID_RESPONSE' })
    const controller = new AbortController(); controller.abort()
    const cancelled = registryWithSource(vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') }))
    await expect(cancelled.run('query_options', { sourceId: 'people' }, context(controller.signal))).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_CANCELLED' })
  })

  it('forwards the trusted cancellation signal to injected fetch', async () => {
    const controller = new AbortController()
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).not.toBe(controller.signal)
      expect(init?.signal?.aborted).toBe(false)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
    })
    const registry = registryWithSource(fetch)
    const pending = registry.run('query_options', { sourceId: 'people' }, context(controller.signal))
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_CANCELLED' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('times out a fetch that never settles and aborts its injected signal', async () => {
    vi.useFakeTimers()
    try {
      let fetchSignal: AbortSignal | undefined
      const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal as AbortSignal
        return new Promise<Response>(() => {})
      })
      const registry = registryWithSource(fetch, 5)
      const pending = registry.run('query_options', { sourceId: 'people' }, context())
      const resolved = expect(pending).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(5)
      await resolved
      expect(fetchSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels while reading a response body even when json ignores its signal', async () => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response
    })
    const registry = registryWithSource(fetch)
    const pending = registry.run('query_options', { sourceId: 'people' }, context(controller.signal))
    await Promise.resolve()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'API_OPTIONS_CANCELLED' })
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('maps a source ApiToolsError to a fixed message without leaking its message', async () => {
    const secret = 'Bearer customer-secret https://private.example'
    const source: OptionsSource = {
      id: 'secret',
      query: async () => { throw new ApiToolsError('API_OPTIONS_SERVICE_ERROR', secret, true) },
    }
    const registry = createToolRegistry()
    registerApiTools(registry, createApiToolsHost([source], { isSourceAllowed: () => true }))
    const result = await registry.run('query_options', { sourceId: 'secret' }, context())
    expect(result).toEqual({ ok: false, error: 'options source request failed', code: 'API_OPTIONS_SERVICE_ERROR', retryable: true })
    expect(JSON.stringify(result)).not.toContain('customer-secret')
  })
})
