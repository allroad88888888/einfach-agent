import { describe, expect, it, vi } from 'vitest'
import { probeConnectionProfileModels } from './connectionProfileProbe'

const SECRET = 'probe-super-secret'

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('probeConnectionProfileModels', () => {
  it('requests only normalized /models and returns sorted unique public metadata', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        data: [{ id: ' zeta ' }, { id: 'alpha' }, { id: 'alpha', owned_by: 'secret' }],
      }))
    await expect(probeConnectionProfileModels(
      { baseUrl: ' https://gateway.example.com/v1/ ', apiKey: ` ${SECRET} ` },
      { fetchImpl },
    )).resolves.toEqual({
      models: [
        { id: 'alpha', label: 'alpha', source: 'discovered' },
        { id: 'zeta', label: 'zeta', source: 'discovered' },
      ],
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://gateway.example.com/v1/models')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`)
  })

  it('omits Authorization when no key is supplied', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return jsonResponse({ data: [] })
    })
    await expect(probeConnectionProfileModels(
      { baseUrl: 'http://127.0.0.1:11434/v1' },
      { fetchImpl },
    )).resolves.toEqual({ models: [] })
  })

  it.each([
    'http://gateway.example.com/v1',
    'https://user:pass@gateway.example.com/v1',
    'https://gateway.example.com/v1?key=secret',
  ])('rejects an unsafe base URL before fetch: %s', async (baseUrl) => {
    const fetchImpl = vi.fn()
    await expect(probeConnectionProfileModels({ baseUrl }, { fetchImpl }))
      .rejects.toMatchObject({ reason: 'target-not-allowed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { data: 'not-an-array' },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: '' }] },
    { data: [{ id: 'bad\nmodel' }] },
  ])('rejects malformed responses without exposing body or key', async (payload) => {
    const error = await probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1', apiKey: SECRET },
      { fetchImpl: async () => jsonResponse(payload) },
    ).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ reason: 'upstream-failed' })
    expect(String(error)).not.toContain(JSON.stringify(payload))
    expect(String(error)).not.toContain(SECRET)
  })

  it('bounds declared and streamed response bodies', async () => {
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      {
        fetchImpl: async () => jsonResponse({ data: [] }, { headers: { 'content-length': '999' } }),
        maxResponseBytes: 10,
      },
    )).rejects.toMatchObject({ reason: 'upstream-failed' })
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      { fetchImpl: async () => jsonResponse({ data: [{ id: 'model' }] }), maxResponseBytes: 5 },
    )).rejects.toMatchObject({ reason: 'upstream-failed' })
  })

  it('rejects redirects without following them or exposing their response', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: `https://${SECRET}.example/models` },
    }))
    const error = await probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1', apiKey: SECRET },
      { fetchImpl },
    ).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ reason: 'upstream-failed' })
    expect(String(error)).not.toContain(SECRET)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('manual')
  })

  it('accepts exactly 1,000 models and rejects 1,001', async () => {
    const models = Array.from({ length: 1_000 }, (_, index) => ({ id: `model-${index}` }))
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      { fetchImpl: async () => jsonResponse({ data: models }) },
    )).resolves.toHaveProperty('models.length', 1_000)
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      { fetchImpl: async () => jsonResponse({ data: [...models, { id: 'overflow' }] }) },
    )).rejects.toMatchObject({ reason: 'upstream-failed' })
  })

  it('accepts a 200-byte model ID and rejects a 201-byte ID', async () => {
    const accepted = 'a'.repeat(200)
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      { fetchImpl: async () => jsonResponse({ data: [{ id: accepted }] }) },
    )).resolves.toEqual({ models: [{ id: accepted, label: accepted, source: 'discovered' }] })
    await expect(probeConnectionProfileModels(
      { baseUrl: 'https://gateway.example.com/v1' },
      { fetchImpl: async () => jsonResponse({ data: [{ id: 'a'.repeat(201) }] }) },
    )).rejects.toMatchObject({ reason: 'upstream-failed' })
  })

  it('sanitizes non-2xx, network, and timeout failures', async () => {
    const cases: Array<typeof globalThis.fetch> = [
      async () => jsonResponse({ error: SECRET }, { status: 401 }),
      async () => { throw new Error(`failed at https://${SECRET}.example`) },
      async (_url, init) => await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(SECRET)), { once: true })
      }),
    ]
    for (const fetchImpl of cases) {
      const error = await probeConnectionProfileModels(
        { baseUrl: 'https://gateway.example.com/v1', apiKey: SECRET },
        { fetchImpl, timeoutMs: 5 },
      ).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ reason: 'upstream-failed' })
      expect(String(error)).not.toContain(SECRET)
    }
  })
})
