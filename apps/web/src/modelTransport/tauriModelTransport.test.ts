import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTauriModelFetch } from './tauriModelTransport'

type ModelProxyEvent = {
  type: 'started' | 'response' | 'chunk' | 'end' | 'error'
  status?: number
  contentType?: string
  retryAfter?: string
  bytes?: number[]
  message?: string
}

const mocks = vi.hoisted(() => ({
  eventHandlers: [] as Array<(event: ModelProxyEvent) => void>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class TestChannel<T> {
    constructor(handler: (event: T) => void) {
      mocks.eventHandlers.push(handler as (event: ModelProxyEvent) => void)
    }
  },
  invoke: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const deepSeekUrl = 'https://api.deepseek.com/chat/completions'
const kimiFilesUrl = 'https://api.moonshot.cn/v1/files'

async function eventHandler(): Promise<(event: ModelProxyEvent) => void> {
  await vi.waitFor(() => expect(mocks.eventHandlers).toHaveLength(1))
  return mocks.eventHandlers[0]!
}

function commandCalls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command)
}

describe('createTauriModelFetch', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    mocks.eventHandlers.length = 0
  })

  it('原生请求启动后将同一个 requestId 精确取消一次', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'model_provider_request') return new Promise<void>(() => {})
      return Promise.resolve(true)
    })
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}', signal: controller.signal,
    })
    const events = await eventHandler()

    events({ type: 'started' })
    controller.abort()
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const start = commandCalls('model_provider_request')[0]
    const requestId = (start?.[1] as { input: { requestId: string } }).input.requestId
    expect(requestId).toEqual(expect.any(String))
    expect(commandCalls('cancel_model_provider_request'))
      .toEqual([['cancel_model_provider_request', { requestId }]])
  })

  it('先中止时会在原生确认启动后补发取消', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'model_provider_request') return new Promise<void>(() => {})
      return Promise.resolve(true)
    })
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}', signal: controller.signal,
    })
    const events = await eventHandler()

    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(commandCalls('cancel_model_provider_request')).toHaveLength(0)

    events({ type: 'started' })
    const start = commandCalls('model_provider_request')[0]
    const requestId = (start?.[1] as { input: { requestId: string } }).input.requestId
    expect(commandCalls('cancel_model_provider_request'))
      .toEqual([['cancel_model_provider_request', { requestId }]])
  })

  it('forwards the semantic envelope and safe response headers', async () => {
    invokeMock.mockResolvedValue(undefined)
    const request = createTauriModelFetch()(deepSeekUrl, { body: '{"stream":true}' })
    const events = await eventHandler()
    const start = commandCalls('model_provider_request')[0]

    expect(start?.[1]).toMatchObject({
      input: {
        target: {
          provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions',
        },
        body: { kind: 'json', json: '{"stream":true}' },
        requestId: expect.any(String),
      },
    })
    events({ type: 'started' })
    events({
      type: 'response', status: 429,
      contentType: 'application/json', retryAfter: '2',
    })
    events({ type: 'chunk', bytes: [123, 125] })
    events({ type: 'end' })

    const response = await request
    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.text()).toBe('{}')
  })

  it('encodes Kimi multipart data before invoking native code', async () => {
    invokeMock.mockResolvedValue(undefined)
    const form = new FormData()
    form.append('purpose', 'file-extract')
    form.append('file', new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }), 'a.png')
    const request = createTauriModelFetch()(kimiFilesUrl, { method: 'POST', body: form })
    const events = await eventHandler()
    const start = commandCalls('model_provider_request')[0]

    expect((start?.[1] as { input: unknown }).input).toMatchObject({
      target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'purpose', value: 'file-extract' },
          { kind: 'file', name: 'file', fileName: 'a.png', bytesBase64: 'AQID' },
        ],
      },
    })
    events({ type: 'started' })
    events({ type: 'response', status: 200 })
    events({ type: 'end' })
    await expect(request).resolves.toMatchObject({ status: 200 })
  })

  it('完成后不再请求原生取消', async () => {
    invokeMock.mockResolvedValue(undefined)
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}', signal: controller.signal,
    })
    const events = await eventHandler()

    events({ type: 'started' })
    events({ type: 'response', status: 204 })
    events({ type: 'end' })
    await expect(request).resolves.toMatchObject({ status: 204 })
    controller.abort()

    expect(commandCalls('cancel_model_provider_request')).toHaveLength(0)
  })
})
