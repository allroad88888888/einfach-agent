import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_LABELS,
  DEEPSEEK_PRO_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  MAX_DEEPSEEK_USER_ID_LENGTH,
  callDeepSeek,
  normalizeDeepSeekUserId,
  streamDeepSeek,
  type DeepSeekChatRequest,
} from './deepseek'
import { DEEPSEEK_VENDOR_ID, defaultProviderRegistry } from './builtinProviders'

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
            id: 'timed:sessionStart:session_brief',
            type: 'function',
            function: { name: 'timed_tool_result', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'timed:sessionStart:session_brief', content: 'manifest' },
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

describe('DEEPSEEK_MODEL_LABELS', () => {
  // 这三条盯的是同一种漂移：常量改了、写死在别处的中文没跟着改。
  // f838544 把 DEFAULT_DEEPSEEK_MODEL 从 Flash 换成 Pro 时只动了常量和一条测试，
  // 设置面板那句写死的 "DeepSeek V4 Flash" 就这么和 `deepseek-v4-pro` 并排显示了很久 ——
  // 中文字面量没有任何门禁能判，只能靠「展示名从模型名查表来」这个结构 + 下面的覆盖断言。
  it('覆盖 deepseek 能力表里的每一个模型', () => {
    const models = Object.keys(defaultProviderRegistry.describe(DEEPSEEK_VENDOR_ID).models)

    expect(models.length).toBeGreaterThan(0)
    for (const model of models) expect(DEEPSEEK_MODEL_LABELS[model]).toBeTypeOf('string')
  })

  it('覆盖当前默认档与两个子 Agent 档位', () => {
    expect(DEEPSEEK_MODEL_LABELS[DEFAULT_DEEPSEEK_MODEL]).toBeTypeOf('string')
    expect(DEEPSEEK_MODEL_LABELS[DEEPSEEK_PRO_MODEL]).toBe('DeepSeek V4 Pro')
    expect(DEEPSEEK_MODEL_LABELS[DEEPSEEK_FLASH_MODEL]).toBe('DeepSeek V4 Flash')
  })

  it('不含能力表里已经没有的模型名 —— 陈旧条目会让人以为那个档还在', () => {
    const models = new Set(Object.keys(defaultProviderRegistry.describe(DEEPSEEK_VENDOR_ID).models))

    for (const labelled of Object.keys(DEEPSEEK_MODEL_LABELS)) expect(models.has(labelled)).toBe(true)
  })
})
