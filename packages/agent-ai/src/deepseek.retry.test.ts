import { describe, expect, it } from 'vitest'
import { streamDeepSeek } from './deepseek'

const BASE_URL = 'https://deepseek.example/v1'

function request() {
  return {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user' as const, content: 'hi' }],
  }
}

function streamResponse(chunks: unknown[]): Response {
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

function streamFinishReason(content: string, finishReason: string): Response {
  return streamResponse([
    { choices: [{ delta: { role: 'assistant', content } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
  ])
}

function jsonFinishReason(
  message: Record<string, unknown>,
  finishReason = 'insufficient_system_resource',
): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finishReason, message }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function fetchSequence(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch
  calls(): number
} {
  let count = 0
  return {
    async fetchImpl() {
      const response = responses[Math.min(count, responses.length - 1)]!
      count += 1
      if (response instanceof Error) throw response
      return response
    },
    calls: () => count,
  }
}

function options(fetchImpl: typeof fetch, signal?: AbortSignal) {
  return {
    apiKey: 'test-key',
    baseUrl: BASE_URL,
    fetchImpl,
    retry: { maxRetries: 0 },
    signal,
  }
}

describe('DeepSeek 容量重试', () => {
  it('空响应重试一次后恢复', async () => {
    const sequence = fetchSequence([
      streamFinishReason('', 'insufficient_system_resource'),
      streamFinishReason('容量恢复', 'stop'),
    ])
    const events: string[] = []

    const response = await streamDeepSeek(
      request(),
      options(sequence.fetchImpl),
      undefined,
      { onRetry: ({ status }) => events.push(status) },
    )

    expect(sequence.calls()).toBe(2)
    expect(events).toEqual(['retrying', 'recovered'])
    expect(response.choices?.[0]?.finish_reason).toBe('stop')
  })

  it('只重试一次，到达上限后收尾', async () => {
    const sequence = fetchSequence([
      streamFinishReason('', 'insufficient_system_resource'),
      streamFinishReason('', 'insufficient_system_resource'),
    ])
    const events: string[] = []

    const response = await streamDeepSeek(
      request(),
      options(sequence.fetchImpl),
      undefined,
      { onRetry: ({ status }) => events.push(status) },
    )

    expect(sequence.calls()).toBe(2)
    expect(events).toEqual(['retrying', 'exhausted'])
    expect(response.choices?.[0]?.finish_reason).toBe('insufficient_system_resource')
  })

  it('已有流式正文时不重放请求', async () => {
    const sequence = fetchSequence([streamFinishReason('半截内容', 'insufficient_system_resource')])

    await streamDeepSeek(request(), options(sequence.fetchImpl))

    expect(sequence.calls()).toBe(1)
  })

  it('非流式兼容响应已有正文时不重放请求', async () => {
    const sequence = fetchSequence([
      jsonFinishReason({ role: 'assistant', content: '兼容响应中的正文' }),
    ])

    await streamDeepSeek(request(), options(sequence.fetchImpl))

    expect(sequence.calls()).toBe(1)
  })

  it('响应含正常 tool_calls 时不重放请求', async () => {
    const sequence = fetchSequence([
      jsonFinishReason({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"config.json"}' },
        }],
      }),
    ])

    await streamDeepSeek(request(), options(sequence.fetchImpl))

    expect(sequence.calls()).toBe(1)
  })

  it('响应含畸形 tool_calls 时仍不重放请求', async () => {
    const sequence = fetchSequence([
      jsonFinishReason({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'malformed-call',
          type: 'function',
          function: { arguments: '{}' },
        }],
      }),
    ])

    await streamDeepSeek(request(), options(sequence.fetchImpl))

    expect(sequence.calls()).toBe(1)
  })

  it('运行时守卫拒绝重试时不发送第二个请求', async () => {
    const sequence = fetchSequence([streamFinishReason('', 'insufficient_system_resource')])

    await streamDeepSeek(
      request(),
      options(sequence.fetchImpl),
      undefined,
      { canRetry: () => false },
    )

    expect(sequence.calls()).toBe(1)
  })

  it('AbortSignal 已中断时不发送第二个请求', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      controller.abort()
      return streamFinishReason('', 'insufficient_system_resource')
    }

    await streamDeepSeek(request(), options(fetchImpl, controller.signal))

    expect(calls).toBe(1)
  })

  it('重试后请求失败时透传失败且不伪报恢复', async () => {
    const sequence = fetchSequence([
      streamFinishReason('', 'insufficient_system_resource'),
      new Response('unauthorized', { status: 401 }),
    ])
    const events: string[] = []

    await expect(
      streamDeepSeek(
        request(),
        options(sequence.fetchImpl),
        undefined,
        { onRetry: ({ status }) => events.push(status) },
      ),
    ).rejects.toThrow()

    expect(sequence.calls()).toBe(2)
    expect(events).toEqual(['retrying'])
  })
})
