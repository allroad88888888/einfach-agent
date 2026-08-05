import { describe, expect, it } from 'vitest'
import { streamDeepSeek } from './deepseek'
import { streamGlm } from './glm'
import type {
  ChatCallOptions,
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
} from './modelApi'

type StreamProvider = (
  body: ChatRequestBase,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
) => Promise<ModelChatResponse>

const PROVIDERS: Array<{ name: string; stream: StreamProvider }> = [
  { name: 'DeepSeek', stream: streamDeepSeek },
  { name: 'GLM', stream: streamGlm },
]

const REQUEST: ChatRequestBase = {
  model: 'characterization-model',
  messages: [{ role: 'user', content: 'hello' }],
}

function sseResponse(chunks: unknown[]): Response {
  const source = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(source))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function successfulStream(content = 'ok'): Response {
  return sseResponse([
    { choices: [{ delta: { role: 'assistant', content } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ])
}

function capacityStream(): Response {
  return sseResponse([
    { choices: [{ delta: { role: 'assistant', content: '' } }] },
    { choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] },
  ])
}

function brokenStreamAfter(content: string): Response {
  const encoder = new TextEncoder()
  let emitted = false
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) {
          controller.error(new Error('stream disconnected'))
          return
        }
        emitted = true
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        ))
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('provider retry characterization', () => {
  it.each(PROVIDERS)('$name 在首个 delta 前遇到 503 时按共享策略重试', async ({ stream }) => {
    let calls = 0
    const waits: number[] = []
    const visibleDeltas: string[] = []

    const response = await stream(
      REQUEST,
      {
        apiKey: 'key',
        baseUrl: 'https://provider.example/v1',
        fetchImpl: async () => {
          calls += 1
          return calls === 1
            ? new Response('temporarily unavailable', { status: 503 })
            : successfulStream('recovered')
        },
        retry: {
          maxRetries: 1,
          baseDelayMs: 7,
          jitter: false,
          sleepImpl: async (ms) => { waits.push(ms) },
        },
      },
      {
        onDelta(delta) {
          if (delta.content) visibleDeltas.push(delta.content)
        },
      },
    )

    expect(calls).toBe(2)
    expect(waits).toEqual([7])
    expect(visibleDeltas).toEqual(['recovered'])
    expect(response.choices?.[0]?.message?.content).toBe('recovered')
  })

  it.each(PROVIDERS)('$name 已 emit 可见 delta 后断流时不重放请求', async ({ stream }) => {
    let calls = 0
    const visibleDeltas: string[] = []

    await expect(stream(
      REQUEST,
      {
        apiKey: 'key',
        baseUrl: 'https://provider.example/v1',
        fetchImpl: async () => {
          calls += 1
          return brokenStreamAfter('partial')
        },
        retry: {
          maxRetries: 2,
          sleepImpl: async () => {
            throw new Error('retry sleep must not run after visible output')
          },
        },
      },
      {
        onDelta(delta) {
          if (delta.content) visibleDeltas.push(delta.content)
        },
      },
    )).rejects.toThrow('stream disconnected')

    expect(calls).toBe(1)
    expect(visibleDeltas).toEqual(['partial'])
  })

  it('DeepSeek 对空的容量终止响应额外重试一次并报告恢复', async () => {
    let calls = 0
    const events: string[] = []

    const response = await streamDeepSeek(
      { ...REQUEST, model: 'deepseek-v4-pro' },
      {
        apiKey: 'key',
        baseUrl: 'https://deepseek.example/v1',
        fetchImpl: async () => {
          calls += 1
          return calls === 1 ? capacityStream() : successfulStream('recovered')
        },
        retry: { maxRetries: 0 },
      },
      undefined,
      { onRetry: ({ status }) => events.push(status) },
    )

    expect(calls).toBe(2)
    expect(events).toEqual(['retrying', 'recovered'])
    expect(response.choices?.[0]?.message?.content).toBe('recovered')
  })

  it('GLM 不继承 DeepSeek 的容量 finish_reason 重试', async () => {
    let calls = 0

    const response = await streamGlm(
      { ...REQUEST, model: 'glm-5.2' },
      {
        apiKey: 'key',
        baseUrl: 'https://glm.example/v4',
        fetchImpl: async () => {
          calls += 1
          return capacityStream()
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(calls).toBe(1)
    expect(response.choices?.[0]?.finish_reason).toBe('insufficient_system_resource')
    expect(response.choices?.[0]?.message?.content).toBeNull()
  })
})
