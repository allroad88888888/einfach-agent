import { describe, expect, it } from 'vitest'
import {
  MAX_DEEPSEEK_USER_ID_LENGTH,
  callDeepSeek,
  normalizeDeepSeekUserId,
  streamDeepSeek,
  type DeepSeekChatRequest,
} from './deepseek'

const BASE_URL = 'https://deepseek.example/v1'

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

function okStreamResponse(contentType = 'text/event-stream', splitSsePrefix = false): Response {
  const source = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (splitSsePrefix) controller.enqueue(encoder.encode(source.slice(0, 2)))
        controller.enqueue(encoder.encode(splitSsePrefix ? source.slice(2) : source))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': contentType } },
  )
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('DeepSeek V4 请求协议', () => {
  it('只接受 DeepSeek user_id 协议允许的字符和长度', () => {
    expect(normalizeDeepSeekUserId('wa_abc-XYZ_0123')).toBe('wa_abc-XYZ_0123')
    expect(normalizeDeepSeekUserId('')).toBeUndefined()
    expect(normalizeDeepSeekUserId('person@example.com')).toBeUndefined()
    expect(normalizeDeepSeekUserId('/Users/person/project')).toBeUndefined()
    expect(normalizeDeepSeekUserId('a'.repeat(MAX_DEEPSEEK_USER_ID_LENGTH + 1)))
      .toBeUndefined()
    expect(normalizeDeepSeekUserId(42)).toBeUndefined()
  })

  it('thinking 开启时移除不支持的采样参数和 tool_choice，并允许 max reasoning effort', async () => {
    let captured: Record<string, unknown> | undefined
    const body: DeepSeekChatRequest = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '分析这个问题' }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      user_id: 'wa_valid-user_0123',
      temperature: 0.2,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    }

    await callDeepSeek(body, {
      apiKey: 'test-key',
      baseUrl: BASE_URL,
      fetchImpl: async (_input, init) => {
        captured = requestBody(init)
        return okResponse()
      },
      retry: { maxRetries: 0 },
    })

    expect(captured).toMatchObject({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      user_id: 'wa_valid-user_0123',
    })
    expect(captured).not.toHaveProperty('temperature')
    expect(captured).not.toHaveProperty('top_p')
    expect(captured).not.toHaveProperty('presence_penalty')
    expect(captured).not.toHaveProperty('frequency_penalty')
    expect(captured).not.toHaveProperty('tool_choice')
    expect(body).toMatchObject({
      temperature: 0.2,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    })
  })

  it('thinking 关闭时原样保留采样参数和 tool_choice', async () => {
    let captured: Record<string, unknown> | undefined

    await callDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '简短回答' }],
        thinking: { type: 'disabled' },
        reasoning_effort: 'high',
        temperature: 0.2,
        top_p: 0.8,
        presence_penalty: 0.1,
        frequency_penalty: 0.3,
        tool_choice: 'required',
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(captured).toMatchObject({
      thinking: { type: 'disabled' },
      temperature: 0.2,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
      tool_choice: 'required',
    })
  })

  it('流式请求同样净化 sampling 字段，并继续注入 usage 开关', async () => {
    let captured: Record<string, unknown> | undefined

    await streamDeepSeek(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: '流式分析' }],
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        user_id: 'wa_stream-user_0123',
        temperature: 0.5,
        top_p: 0.9,
        presence_penalty: 0,
        frequency_penalty: 0,
        tool_choice: 'auto',
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okStreamResponse()
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(captured).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      user_id: 'wa_stream-user_0123',
    })
    expect(captured).not.toHaveProperty('temperature')
    expect(captured).not.toHaveProperty('top_p')
    expect(captured).not.toHaveProperty('presence_penalty')
    expect(captured).not.toHaveProperty('frequency_penalty')
    expect(captured).not.toHaveProperty('tool_choice')
  })

  it('上游误标 SSE 为 JSON 时仍按流协议解析', async () => {
    const deltas: string[] = []

    const result = await streamDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '流式响应' }],
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl: async () => okStreamResponse('application/json', true),
        retry: { maxRetries: 0 },
      },
      { onDelta: (delta) => deltas.push(delta.content ?? '') },
    )

    expect(deltas).toEqual(['ok', ''])
    expect(result.choices?.[0]?.message?.content).toBe('ok')
  })

  it('净化请求时保留 reasoning_content，并把工具调用 assistant 的 null content 规范为空串', async () => {
    let captured: Record<string, unknown> | undefined
    const messages: DeepSeekChatRequest['messages'] = [
      { role: 'user', content: '读取配置' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '需要先读取配置文件，再继续回答。',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"config.json"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"enabled":true}' },
    ]

    await callDeepSeek(
      {
        model: 'deepseek-v4-pro',
        messages,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        temperature: 0.2,
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(captured?.messages).toEqual([
      messages[0],
      {
        ...messages[1],
        content: '',
      },
      messages[2],
    ])
    expect(messages[1]).toMatchObject({
      content: null,
      reasoning_content: '需要先读取配置文件，再继续回答。',
    })
  })

  it('工具调用 assistant 缺 reasoning_content 时补空串（合成配对轮的 thinking 校验要求）', async () => {
    let captured: Record<string, unknown> | undefined
    const messages: DeepSeekChatRequest['messages'] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'timed:sessionStart:skill_manifest',
            type: 'function',
            function: { name: 'timed_tool_result', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest', content: 'manifest' },
    ]

    // 故意不带 thinking 字段：服务端把全部 deepseek 别名路由到 thinking 家族，
    // 归一化必须在默认路径同样生效。
    await callDeepSeek(
      { model: 'deepseek-v4-flash', messages },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(captured?.messages).toEqual([
      messages[0],
      { ...messages[1], reasoning_content: '' },
      messages[2],
    ])
  })

  it('不会隐式生成 user_id，并在协议边界丢弃非法值', async () => {
    const captured: Record<string, unknown>[] = []
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(requestBody(init))
      return okResponse()
    }

    await callDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '无 user id' }],
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl,
        retry: { maxRetries: 0 },
      },
    )
    await callDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '非法 user id' }],
        user_id: 'person@example.com',
      },
      {
        apiKey: 'test-key',
        baseUrl: BASE_URL,
        fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    expect(captured).toHaveLength(2)
    expect(captured[0]).not.toHaveProperty('user_id')
    expect(captured[1]).not.toHaveProperty('user_id')
  })
})
