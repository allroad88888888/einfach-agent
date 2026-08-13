import { describe, expect, it } from 'vitest'
import {
  createDeepSeekMaxTargetedCases,
  createDeepSeekProtocolMatrix,
} from './matrix'
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
    const maxTargeted = createDeepSeekMaxTargetedCases()

    expect(matrix).toHaveLength(16)
    expect(new Set(matrix.map((item) => item.model)).size).toBe(2)
    expect(new Set(matrix.map((item) => item.thinking))).toEqual(new Set([false, true]))
    expect(new Set(matrix.map((item) => item.stream))).toEqual(new Set([false, true]))
    expect(new Set(matrix.map((item) => item.toolCall))).toEqual(new Set([false, true]))
    expect(matrix.filter((item) => item.thinking).every((item) => item.effort === 'high')).toBe(true)
    expect(matrix.filter((item) => !item.thinking).every((item) => item.effort === null)).toBe(true)
    expect(maxTargeted).toHaveLength(2)
    expect(maxTargeted.every((item) => item.thinking && item.effort === 'max')).toBe(true)
    expect(new Set(maxTargeted.map((item) => item.model))).toEqual(
      new Set(matrix.map((item) => item.model)),
    )
    expect(new Set(maxTargeted.map((item) => item.stream))).toEqual(new Set([false, true]))
    expect(new Set(maxTargeted.map((item) => item.toolCall))).toEqual(new Set([false, true]))
  })

  it('runs the main matrix and targeted max cases with redacted request-shape evidence', async () => {
    let time = 1_700_000_000_000
    const cases = [
      ...createDeepSeekProtocolMatrix(),
      ...createDeepSeekMaxTargetedCases(),
    ]
    const results = await runDeepSeekProtocolMatrix(cases, {
      apiKey: 'offline-key',
      fetchImpl: fakeDeepSeek(),
      retry: { maxRetries: 0 },
      now: () => time++,
    })

    expect(results).toHaveLength(18)
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
    for (const result of results) {
      expect(result.request_shapes).toHaveLength(result.request_count)
      expect(result.request_shapes.every((shape) =>
        shape.body_parseable &&
        shape.has_thinking &&
        shape.has_tools === result.tool_call &&
        shape.has_tool_choice === (result.tool_call && !result.thinking)
      )).toBe(true)
      if (result.tool_call) {
        expect(result.request_shapes[0]?.assistant_tool_call).toBeNull()
        // adapter 现对工具调用轮无条件补 reasoning_content/非空 content：
        // DeepSeek 服务端把全部别名路由到 thinking 家族，缺字段在默认路径也会 400。
        expect(result.request_shapes[1]?.assistant_tool_call).toEqual({
          has_reasoning_content: true,
          content_non_null: true,
        })
      } else {
        expect(result.request_shapes.every((shape) =>
          shape.assistant_tool_call === null
        )).toBe(true)
      }
    }
    expect(JSON.stringify(results.map((result) => result.request_shapes))).not.toMatch(
      /pong|brief reasoning|left|right|add/,
    )
  })

  it('normalizes thinking tool turns and records retries/statuses', async () => {
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
      request_shapes: [
        {
          body_parseable: true,
          has_tool_choice: false,
          has_thinking: true,
          has_tools: true,
          assistant_tool_call: null,
        },
        {
          body_parseable: true,
          has_tool_choice: false,
          has_thinking: true,
          has_tools: true,
          assistant_tool_call: null,
        },
        {
          body_parseable: true,
          has_tool_choice: false,
          has_thinking: true,
          has_tools: true,
          assistant_tool_call: {
            has_reasoning_content: true,
            content_non_null: true,
          },
        },
      ],
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
      content: '',
      reasoning_content: 'brief reasoning',
      tool_calls: [{
        id: 'call_add',
        function: { name: 'add', arguments: '{"left":2,"right":3}' },
      }],
    })
    expect(secondBody).not.toHaveProperty('tool_choice')
  })
})
