import { describe, expect, it } from 'vitest'
import { createDeepSeekProtocolMatrix } from './matrix'
import { runDeepSeekEvalCase, runDeepSeekProtocolMatrix } from './runner'

interface FakeDeepSeekOptions {
  failFirst?: boolean
  capturedBodies?: Array<Record<string, unknown>>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}

function fakeDeepSeek(options: FakeDeepSeekOptions = {}): typeof fetch {
  let calls = 0
  return async (_input, init) => {
    calls += 1
    if (options.failFirst && calls === 1) {
      return jsonResponse({ error: { message: 'temporary overload' } }, 503)
    }

    const body = JSON.parse(String(init?.body)) as {
      model: string
      stream?: boolean
      thinking?: { type?: string }
      messages?: Array<{ role?: string }>
      tools?: unknown[]
    }
    options.capturedBodies?.push(body as Record<string, unknown>)
    const isToolRequest = Array.isArray(body.tools) && !body.messages?.some((item) => item.role === 'tool')
    const isToolResult = body.messages?.some((item) => item.role === 'tool') ?? false
    const reasoning = body.thinking?.type === 'enabled' ? 'brief reasoning' : undefined
    const usage = {
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 12,
    }
    const finishReason = isToolRequest ? 'tool_calls' : 'stop'
    const content = isToolRequest ? null : isToolResult ? 'The result is 5.' : 'pong'
    const toolCalls = isToolRequest
      ? [{
        index: 0,
        id: 'call_add',
        type: 'function',
        function: { name: 'add', arguments: '{"left":2,"right":3}' },
      }]
      : undefined

    if (!body.stream) {
      return jsonResponse({
        id: `fake-${calls}`,
        model: body.model,
        choices: [{
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        }],
        usage,
      })
    }

    return sseResponse([
      {
        choices: [{
          delta: {
            role: 'assistant',
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(content ? { content } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: finishReason }] },
      { choices: [], usage },
    ])
  }
}

describe('DeepSeek protocol eval matrix', () => {
  it('covers the complete model/thinking/stream/tool-call product matrix', () => {
    const matrix = createDeepSeekProtocolMatrix()

    expect(matrix).toHaveLength(16)
    expect(new Set(matrix.map((item) => item.model)).size).toBe(2)
    expect(new Set(matrix.map((item) => item.thinking))).toEqual(new Set([false, true]))
    expect(new Set(matrix.map((item) => item.stream))).toEqual(new Set([false, true]))
    expect(new Set(matrix.map((item) => item.toolCall))).toEqual(new Set([false, true]))
    expect(matrix.filter((item) => item.thinking).every((item) => item.effort === 'high')).toBe(true)
    expect(matrix.filter((item) => !item.thinking).every((item) => item.effort === null)).toBe(true)
  })

  it('runs all 16 cases offline and emits comparable result records', async () => {
    let time = 1_700_000_000_000
    const results = await runDeepSeekProtocolMatrix(createDeepSeekProtocolMatrix(), {
      apiKey: 'offline-key',
      fetchImpl: fakeDeepSeek(),
      retry: { maxRetries: 0 },
      now: () => time++,
    })

    expect(results).toHaveLength(16)
    expect(results.every((result) => result.success)).toBe(true)
    expect(results.every((result) => result.http_status === 200)).toBe(true)
    expect(results.every((result) => result.finish_reason === 'stop')).toBe(true)
    expect(results.every((result) => result.tokens.total !== null)).toBe(true)
    expect(results.every((result) => result.cache.hit !== null)).toBe(true)
    expect(results.filter((result) => result.tool_call).every((result) =>
      result.finish_reasons.join(',') === 'tool_calls,stop'
    )).toBe(true)
    expect(results.filter((result) => result.stream).every((result) =>
      result.stream_delta_count > 0
    )).toBe(true)
  })

  it('preserves reasoning_content in the tool result round and records retries/statuses', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    const testCase = createDeepSeekProtocolMatrix().find((item) =>
      item.thinking && !item.stream && item.toolCall
    )
    expect(testCase).toBeDefined()
    if (!testCase) return

    const result = await runDeepSeekEvalCase(testCase, {
      apiKey: 'offline-key',
      fetchImpl: fakeDeepSeek({ failFirst: true, capturedBodies }),
      retry: {
        maxRetries: 1,
        baseDelayMs: 0,
        jitter: false,
        sleepImpl: async () => {},
      },
    })

    expect(result).toMatchObject({
      success: true,
      request_count: 3,
      http_statuses: [503, 200, 200],
      retry_count: 1,
      finish_reasons: ['tool_calls', 'stop'],
      tokens: { input: 40, output: 8, total: 48 },
      cache: { hit: 16, miss: 24, miss_source: 'provider' },
    })
    const secondBody = capturedBodies[1] as {
      messages?: Array<Record<string, unknown>>
    }
    expect(secondBody.messages?.find((item) => item.role === 'assistant')).toMatchObject({
      reasoning_content: 'brief reasoning',
      tool_calls: [{
        id: 'call_add',
        function: { name: 'add', arguments: '{"left":2,"right":3}' },
      }],
    })
  })
})
