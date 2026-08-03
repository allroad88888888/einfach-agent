import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { createTauriModelFetch } from './tauriModelTransport'

type ModelProxyEvent = {
  type: 'started' | 'response' | 'chunk' | 'end' | 'error'
  status?: number
  contentType?: string
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

describe('createTauriModelFetch', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    mocks.eventHandlers.length = 0
  })

  it('原生请求启动后将同一个 requestId 精确取消一次', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'model_chat_completions') return new Promise<void>(() => {})
      return Promise.resolve(true)
    })
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}',
      signal: controller.signal,
    })

    mocks.eventHandlers[0]!({ type: 'started' })
    controller.abort()
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const start = invokeMock.mock.calls.find(([command]) => command === 'model_chat_completions')
    const cancellation = invokeMock.mock.calls.filter(([command]) => command === 'cancel_model_chat_completions')
    const requestId = (start?.[1] as { input: { requestId: string } }).input.requestId
    expect(requestId).toEqual(expect.any(String))
    expect(cancellation).toEqual([['cancel_model_chat_completions', { requestId }]])
  })

  it('先中止时会在原生确认启动后补发取消', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'model_chat_completions') return new Promise<void>(() => {})
      return Promise.resolve(true)
    })
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}',
      signal: controller.signal,
    })

    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cancel_model_chat_completions')).toHaveLength(0)

    mocks.eventHandlers[0]!({ type: 'started' })
    const start = invokeMock.mock.calls.find(([command]) => command === 'model_chat_completions')
    const requestId = (start?.[1] as { input: { requestId: string } }).input.requestId
    expect(invokeMock.mock.calls.filter(([command]) => command === 'cancel_model_chat_completions'))
      .toEqual([['cancel_model_chat_completions', { requestId }]])
  })

  it('完成后不再请求原生取消', async () => {
    invokeMock.mockResolvedValue(undefined)
    const controller = new AbortController()
    const request = createTauriModelFetch()(deepSeekUrl, {
      body: '{}',
      signal: controller.signal,
    })

    mocks.eventHandlers[0]!({ type: 'started' })
    mocks.eventHandlers[0]!({ type: 'response', status: 200 })
    mocks.eventHandlers[0]!({ type: 'end' })
    await expect(request).resolves.toMatchObject({ status: 200 })
    controller.abort()

    expect(invokeMock.mock.calls.filter(([command]) => command === 'cancel_model_chat_completions')).toHaveLength(0)
  })
})
