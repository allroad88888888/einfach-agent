import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeepSeekSearch } from './deepseekSearch'

const context = () => ({ signal: new AbortController().signal })
const result = {
  title: '标题', url: 'https://example.com/article', snippet: '简述', summary: '长摘要',
  content: '# 正文', site_name: null, site_icon: null, date: null, rerank_score: 2.4, authority: 3,
}
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value))

afterEach(() => vi.useRealTimers())

describe('DeepSeek search API', () => {
  it('uses the official endpoint and the supplied model credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ results: [{ ...result, private: 'ignored' }] }))
    const search = createDeepSeekSearch({ apiKey: ' model-key ', fetchImpl })
    const input = { query: '天气', count: 2, ori_question: '今天天气如何', localization: '1.1.1.1', need_content: true }
    await expect(search(input, context())).resolves.toEqual({ ok: true, data: { results: [result] } })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/v1/tools/search', expect.objectContaining({
      method: 'POST', redirect: 'error', body: JSON.stringify(input),
      headers: { Authorization: 'Bearer model-key', 'Content-Type': 'application/json' },
    }))
  })

  it('treats empty results as success', async () => {
    const search = createDeepSeekSearch({ apiKey: 'key', fetchImpl: async () => jsonResponse({ results: [] }) })
    await expect(search({ query: 'x' }, context())).resolves.toEqual({ ok: true, data: { results: [] } })
  })

  it('does not send a request without a key or after cancellation', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(createDeepSeekSearch({ apiKey: ' ', fetchImpl })({ query: 'x' }, context()))
      .resolves.toMatchObject({ code: 'DEEPSEEK_SEARCH_MISSING_KEY', retryable: false })
    await expect(createDeepSeekSearch({ apiKey: 'key', fetchImpl })({ query: 'x' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ code: 'DEEPSEEK_SEARCH_ABORTED', retryable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([[400, false], [401, false], [402, false], [408, true], [429, true], [500, true], [504, true]])(
    'reports HTTP %i with retryable=%s without echoing upstream content', async (status, retryable) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('secret-key', { status: Number(status) }))
      const failure = await createDeepSeekSearch({ apiKey: 'secret-key', fetchImpl })({ query: 'x' }, context())
      expect(failure).toMatchObject({ ok: false, retryable })
      expect(JSON.stringify(failure)).not.toContain('secret-key')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    },
  )

  it.each([null, {}, { results: null }, { results: [{}] }, { results: [{ ...result, url: 3 }] }])(
    'rejects malformed successful responses: %j', async (payload) => {
      const search = createDeepSeekSearch({ apiKey: 'key', fetchImpl: async () => jsonResponse(payload) })
      await expect(search({ query: 'x' }, context())).resolves.toMatchObject({ code: 'DEEPSEEK_SEARCH_INVALID_RESPONSE' })
    },
  )

  it('redacts transport errors but preserves the known missing credential message', async () => {
    for (const message of ['secret-key', '未配置 DeepSeek API Key']) {
      const search = createDeepSeekSearch({ apiKey: 'key', fetchImpl: async () => { throw new Error(message) } })
      const failure = await search({ query: 'x' }, context())
      expect(failure).toMatchObject({
        ok: false, code: message === 'secret-key' ? 'DEEPSEEK_SEARCH_FAILED' : 'DEEPSEEK_SEARCH_MISSING_KEY',
      })
      expect(JSON.stringify(failure)).not.toContain('secret-key')
    }
  })

  it('recognizes missing credentials from the server proxy without retrying', async () => {
    const search = createDeepSeekSearch({
      apiKey: 'host-managed',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'model_credential_missing', message: 'private server details',
      }), { status: 503 }),
    })
    const failure = await search({ query: 'x' }, context())
    expect(failure).toMatchObject({ code: 'DEEPSEEK_SEARCH_MISSING_KEY', retryable: false })
    expect(JSON.stringify(failure)).not.toContain('private server details')
  })

  it('reports non-JSON responses without repeating their content', async () => {
    const search = createDeepSeekSearch({ apiKey: 'key', fetchImpl: async () => new Response('private-html') })
    const failure = await search({ query: 'x' }, context())
    expect(failure).toMatchObject({ code: 'DEEPSEEK_SEARCH_INVALID_RESPONSE', retryable: false })
    expect(JSON.stringify(failure)).not.toContain('private-html')
  })

  it.each(['cancel', 'timeout'])('aborts an in-flight request on %s', async (action) => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(new Error('private abort details')), { once: true })
      })
    }
    const controller = new AbortController()
    const search = createDeepSeekSearch({ apiKey: 'key', fetchImpl })
    const pending = search({ query: 'x' }, { signal: controller.signal })
    if (action === 'cancel') controller.abort()
    else await vi.advanceTimersByTimeAsync(120_000)
    await expect(pending).resolves.toMatchObject({
      code: action === 'cancel' ? 'DEEPSEEK_SEARCH_ABORTED' : 'DEEPSEEK_SEARCH_TIMEOUT',
      retryable: action === 'timeout',
    })
    expect(requestSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
