import { DEEPSEEK_BASE_URL } from '@web-agent/ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevPreviewModelFetch } from './devPreviewModelTransport'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDevPreviewModelFetch', () => {
  it('rewrites a trusted endpoint to the loopback relay without forwarding authorization', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    await createDevPreviewModelFetch()(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-key' },
      body: '{"stream":true}',
    })

    expect(fetchMock).toHaveBeenCalledWith('/__web_agent_model_preview/deepseek', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":true}',
      signal: undefined,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
  })

  it('rejects a non-allowlisted model endpoint before requesting the relay', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(createDevPreviewModelFetch()('https://untrusted.example/chat/completions', {
      body: '{}',
    })).rejects.toThrow('模型请求目标未获允许')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-POST browser request before requesting the relay', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(createDevPreviewModelFetch()(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'GET', body: '{}',
    })).rejects.toThrow('模型开发请求只允许 POST 方法')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
