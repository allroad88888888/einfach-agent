import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createModelPreviewRelayHandler,
  isLoopbackAddress,
} from './model-preview-relay'
import type { ModelPreviewRelayCredentials } from './model-preview-relay-routes'

const RELAY_PATH = '/__web_agent_model_preview'
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function startRelay(
  fetchImpl: typeof fetch,
  credentials: ModelPreviewRelayCredentials = { deepseek: 'server-key' },
): Promise<string> {
  const relay = createModelPreviewRelayHandler({ credentials, fetchImpl })
  const server = createServer((request, response) => {
    relay(request, response, () => {
      response.statusCode = 404
      response.end('not found')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试中继未监听 TCP 端口')
  return `http://127.0.0.1:${address.port}`
}

function sendEnvelope(origin: string, envelope: unknown): Promise<Response> {
  return fetch(`${origin}${RELAY_PATH}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer browser-supplied-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requestId: 'relay-test', ...(envelope as object) }),
  })
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

describe('model preview relay', () => {
  it('forwards the fixed chat endpoint with only the server credential', async () => {
    const upstreamFetch = vi.fn(async () => new Response('data: ok\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'retry-after': '2' },
    }))
    const origin = await startRelay(upstreamFetch)

    const response = await sendEnvelope(origin, {
      target: {
        provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions',
      },
      body: { kind: 'json', json: '{"model":"deepseek-chat"}' },
    })

    expect(await response.text()).toBe('data: ok\n\n')
    expect(response.headers.get('retry-after')).toBe('2')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    const [url, init] = upstreamFetch.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-key')
    expect(init.body).toBe('{"model":"deepseek-chat"}')
  })

  it('reconstructs Kimi multipart upload data at the fixed CN endpoint', async () => {
    const upstreamFetch = vi.fn(async () => new Response('{}'))
    const origin = await startRelay(upstreamFetch, { kimi: 'kimi-server-key' })

    const response = await sendEnvelope(origin, {
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
    })

    expect(response.status).toBe(200)
    const [url, init] = upstreamFetch.mock.calls[0]!
    expect(url).toBe('https://api.moonshot.cn/v1/files')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer kimi-server-key')
    expect(new Headers(init.headers).has('content-type')).toBe(false)
    const form = init.body as FormData
    expect(form.get('purpose')).toBe('file-extract')
    const file = form.get('file') as File
    expect(file.name).toBe('chart.png')
    expect(file.type).toBe('image/png')
    expect([...new Uint8Array(await readBlob(file))]).toEqual([1, 2, 3])
  })

  it('uses fixed DELETE with no body and rejects unsafe resource IDs', async () => {
    const upstreamFetch = vi.fn(async () => new Response(null, { status: 204 }))
    const origin = await startRelay(upstreamFetch, { kimi: 'kimi-key' })

    const valid = await sendEnvelope(origin, {
      target: {
        provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/file_123.A-b',
      },
      body: { kind: 'none' },
    })
    expect(valid.status).toBe(204)
    const [url, init] = upstreamFetch.mock.calls[0]!
    expect(url).toBe('https://api.moonshot.cn/v1/files/file_123.A-b')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()

    const invalid = await sendEnvelope(origin, {
      target: {
        provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/../secret',
      },
      body: { kind: 'none' },
    })
    expect(invalid.status).toBe(400)
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('fails closed for global Kimi, extra target keys, and body-kind mismatches', async () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const origin = await startRelay(upstreamFetch, { kimi: 'key' })
    const envelopes = [
      {
        target: {
          provider: 'kimi', scope: 'default', method: 'POST', path: '/chat/completions',
        },
        body: { kind: 'json', json: '{}' },
      },
      {
        target: {
          provider: 'kimi', scope: 'cn', method: 'POST', path: '/chat/completions',
          url: 'https://evil.test',
        },
        body: { kind: 'json', json: '{}' },
      },
      {
        target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
        body: { kind: 'json', json: '{}' },
      },
      {
        requestId: 'request with spaces',
        target: {
          provider: 'kimi', scope: 'cn', method: 'POST', path: '/chat/completions',
        },
        body: { kind: 'json', json: '{}' },
      },
    ]
    for (const envelope of envelopes) {
      await expect(sendEnvelope(origin, envelope)).resolves.toMatchObject({ status: 400 })
    }
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects unsupported outer requests and missing credentials', async () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const origin = await startRelay(upstreamFetch, {})

    await expect(fetch(`${origin}${RELAY_PATH}`)).resolves.toMatchObject({ status: 405 })
    await expect(sendEnvelope(origin, {
      target: { provider: 'glm', scope: 'default', method: 'POST', path: '/chat/completions' },
      body: { kind: 'json', json: '{}' },
    })).resolves.toMatchObject({ status: 503 })
    await expect(fetch(`${origin}${RELAY_PATH}/deepseek`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(`${origin}${RELAY_PATH}?provider=glm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).resolves.toMatchObject({ status: 404 })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects a declared upstream response beyond the route cap', async () => {
    const upstreamFetch = vi.fn(async () => new Response('', {
      headers: { 'content-length': String(1024 * 1024 + 1) },
    }))
    const origin = await startRelay(upstreamFetch, { kimi: 'key' })

    const response = await sendEnvelope(origin, {
      target: {
        provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/file_1',
      },
      body: { kind: 'none' },
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('超过大小限制')
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true)
  })

  it.each(['192.168.1.10', '::ffff:192.168.1.10', undefined])(
    'rejects non-loopback address %s',
    (address) => expect(isLoopbackAddress(address)).toBe(false),
  )
})
