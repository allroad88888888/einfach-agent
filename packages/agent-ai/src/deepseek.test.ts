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

function okStreamResponse(): Response {
  const source = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
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
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
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

  it('thinking 开启时移除不支持的采样参数，并允许 max reasoning effort', async () => {
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
    expect(body).toMatchObject({
      temperature: 0.2,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
    })
  })

  it('thinking 关闭时原样保留采样参数', async () => {
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
  })

  it('净化请求时完整保留 tool-call assistant 的 reasoning_content 回填链', async () => {
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

    expect(captured?.messages).toEqual(messages)
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
