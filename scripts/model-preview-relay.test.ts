import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createModelPreviewRelayHandler,
  isLoopbackAddress,
} from './model-preview-relay'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startRelay(fetchImpl: typeof fetch, credentials = { deepseek: 'server-key' }): Promise<string> {
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

describe('model preview relay', () => {
  it('forwards only the fixed endpoint with the server credential', async () => {
    const upstreamFetch = vi.fn(async () => new Response('data: ok\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const origin = await startRelay(upstreamFetch)

    const response = await fetch(`${origin}/__web_agent_model_preview/deepseek`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-supplied-key',
        'content-type': 'application/json',
      },
      body: '{"model":"deepseek-v4-pro"}',
    })

    expect(await response.text()).toBe('data: ok\n\n')
    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ authorization: 'Bearer server-key' }),
      }),
    )
    const [, init] = upstreamFetch.mock.calls[0]
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('{"model":"deepseek-v4-pro"}')
  })

  it('rejects unsupported methods and unavailable providers without calling upstream', async () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const origin = await startRelay(upstreamFetch, {})

    await expect(fetch(`${origin}/__web_agent_model_preview/deepseek`)).resolves.toMatchObject({ status: 405 })
    await expect(fetch(`${origin}/__web_agent_model_preview/glm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).resolves.toMatchObject({ status: 503 })
    await expect(fetch(`${origin}/__web_agent_model_preview/other`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(`${origin}/__web_agent_model_preview/deepseek?provider=glm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).resolves.toMatchObject({ status: 404 })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true)
  })

  it.each(['192.168.1.10', '::ffff:192.168.1.10', undefined])('rejects non-loopback address %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false)
  })
})
