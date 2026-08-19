import { DEEPSEEK_BASE_URL, KIMI_CN_BASE_URL, KIMI_GLOBAL_BASE_URL } from '@einfach-agent/ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevPreviewModelFetch } from './devPreviewModelTransport'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDevPreviewModelFetch', () => {
  it('sends a canonical provider envelope without forwarding browser authorization', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response('ok')
    ))
    vi.stubGlobal('fetch', fetchMock)

    await createDevPreviewModelFetch()(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer browser-key' },
      body: '{"stream":true}',
    })

    expect(fetchMock).toHaveBeenCalledWith('/__web_agent_model_preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.any(String),
      signal: undefined,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      target: {
        provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions',
      },
      body: { kind: 'json', json: '{"stream":true}' },
      requestId: expect.any(String),
    })
  })

  it('encodes ordered multipart fields and file bytes for Kimi CN', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const form = new FormData()
    form.append('purpose', 'file-extract')
    form.append('file', new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }), 'chart.png')

    await createDevPreviewModelFetch()(`${KIMI_CN_BASE_URL}/files`, {
      method: 'POST', body: form,
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({
      target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'purpose', value: 'file-extract' },
          {
            kind: 'file', name: 'file', fileName: 'chart.png',
            contentType: 'image/png', bytesBase64: 'AQID',
          },
        ],
      },
      requestId: expect.any(String),
    })
  })

  it('uses the fixed no-body delete route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await createDevPreviewModelFetch()(`${KIMI_CN_BASE_URL}/files/file_123`, {
      method: 'DELETE',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({
      target: {
        provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/file_123',
      },
      body: { kind: 'none' },
      requestId: expect.any(String),
    })
  })

  it.each([
    'https://untrusted.example/chat/completions',
    `${KIMI_GLOBAL_BASE_URL}/chat/completions`,
  ])('rejects a non-allowlisted endpoint before requesting the relay', async (url) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(createDevPreviewModelFetch()(url, { body: '{}' }))
      .rejects.toThrow('模型请求目标未获允许')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-POST chat request before requesting the relay', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(createDevPreviewModelFetch()(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'GET', body: '{}',
    })).rejects.toThrow('模型请求目标未获允许')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
