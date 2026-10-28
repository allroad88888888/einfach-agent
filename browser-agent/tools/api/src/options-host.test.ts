import { describe, expect, it, vi } from 'vitest'
import { ApiToolsError, createApiToolsHost, MAX_OPTIONS, type ApiCallContext, type OptionsSource } from './options-host'

const context = (sessionId = 'allowed'): ApiCallContext => ({ sessionId, signal: new AbortController().signal })

describe('createApiToolsHost', () => {
  it('passes search, parent filters, and cursor to an authorized source', async () => {
    const query = vi.fn(async () => ({ options: [{ label: 'Paris', value: 'paris' }], nextCursor: 'p2' }))
    const host = createApiToolsHost([{ id: 'cities', query }], { isSourceAllowed: () => true })
    await expect(host.queryOptions({ sourceId: 'cities', query: 'par', cursor: 'p1', parameters: { country: 'FR' } }, context())).resolves.toEqual({ options: [{ label: 'Paris', value: 'paris' }], nextCursor: 'p2' })
    expect(query).toHaveBeenCalledWith(
      { query: 'par', cursor: 'p1', parameters: { country: 'FR' } },
      expect.objectContaining({ sessionId: 'allowed' }),
    )
  })

  it('rejects unknown and unauthorized sources before query executes', async () => {
    const query = vi.fn()
    const source: OptionsSource = { id: 'private', query }
    const host = createApiToolsHost([source], { isSourceAllowed: (_id, session) => session === 'allowed' })
    await expect(host.queryOptions({ sourceId: 'missing' }, context())).rejects.toMatchObject({ code: 'API_OPTIONS_UNKNOWN_SOURCE' })
    await expect(host.queryOptions({ sourceId: 'private' }, context('denied'))).rejects.toMatchObject({ code: 'API_OPTIONS_FORBIDDEN' })
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects duplicate source registrations and malformed source responses', async () => {
    expect(() => createApiToolsHost([{ id: 'a', query: async () => ({ options: [] }) }, { id: 'a', query: async () => ({ options: [] }) }], { isSourceAllowed: () => true })).toThrow(ApiToolsError)
    const host = createApiToolsHost([{ id: 'bad', query: async () => ({ options: [{ label: 'x', value: 1 }] as never[] }) }], { isSourceAllowed: () => true })
    await expect(host.queryOptions({ sourceId: 'bad' }, context())).rejects.toMatchObject({ code: 'API_OPTIONS_INVALID_RESPONSE' })
  })

  it('preserves legacy registration of a long source ID while query input rejects it', async () => {
    const sourceId = 's'.repeat(501)
    const host = createApiToolsHost([{ id: sourceId, query: async () => ({ options: [] }) }], { isSourceAllowed: () => true })
    await expect(host.queryOptions({ sourceId }, context())).rejects.toMatchObject({ code: 'API_OPTIONS_INVALID_INPUT' })
  })

  it('accepts only a finite positive host timeout configuration', () => {
    const source: OptionsSource = { id: 'a', query: async () => ({ options: [] }) }
    expect(() => createApiToolsHost([source], { isSourceAllowed: () => true, timeoutMs: 0 })).toThrow(ApiToolsError)
    expect(() => createApiToolsHost([source], { isSourceAllowed: () => true, timeoutMs: 120_001 })).toThrow(ApiToolsError)
  })

  it('caps oversized lists and marks the returned page as truncated', async () => {
    const options = Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => ({ label: `Option ${index}`, value: String(index) }))
    const host = createApiToolsHost([{ id: 'many', query: async () => ({ options }) }], { isSourceAllowed: () => true })
    await expect(host.queryOptions({ sourceId: 'many' }, context())).resolves.toMatchObject({ options: expect.any(Array), truncated: true })
    const result = await host.queryOptions({ sourceId: 'many' }, context())
    expect(result.options).toHaveLength(MAX_OPTIONS)
  })

  it('rejects a non-cooperative source at the host timeout and aborts its adapter signal', async () => {
    vi.useFakeTimers()
    try {
      let sourceSignal: AbortSignal | undefined
      const host = createApiToolsHost([{
        id: 'slow',
        query: async (_input, sourceContext) => {
          sourceSignal = sourceContext.signal
          return new Promise(() => {})
        },
      }], { isSourceAllowed: () => true, timeoutMs: 5 })
      const pending = host.queryOptions({ sourceId: 'slow' }, context())
      const rejected = expect(pending).rejects.toMatchObject({ code: 'API_OPTIONS_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(5)
      await rejected
      expect(sourceSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects cancellation before a non-cooperative source can return a late result', async () => {
    const controller = new AbortController()
    let resolveSource: ((result: { options: Array<{ label: string; value: string }> }) => void) | undefined
    let sourceSignal: AbortSignal | undefined
    const host = createApiToolsHost([{
      id: 'late',
      query: async (_input, sourceContext) => {
        sourceSignal = sourceContext.signal
        return new Promise((resolve) => { resolveSource = resolve })
      },
    }], { isSourceAllowed: () => true })
    const pending = host.queryOptions({ sourceId: 'late' }, { sessionId: 'allowed', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'API_OPTIONS_CANCELLED' })
    expect(sourceSignal?.aborted).toBe(true)
    resolveSource?.({ options: [{ label: 'late', value: 'late' }] })
  })
})
