import { describe, expect, it, vi } from 'vitest'
import {
  OpenAiCompatConfigError,
  callOpenAiCompat,
  streamOpenAiCompat,
  type OpenAiCompatChatRequest,
} from './openaiCompat'

const BASE_URL = 'https://gateway.example/v1'

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function sseResponse(events: readonly string[]): Response {
  const source = [...events, '[DONE]'].map((event) => `data: ${event}\n\n`).join('')
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

function okStreamResponse(): Response {
  return sseResponse([
    '{"id":"chatcmpl-1","model":"gateway-model","choices":[{"delta":{"role":"assistant","content":"你"}}]}',
    '{"choices":[{"delta":{"content":"好"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}',
  ])
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

const CALL_OPTIONS = { apiKey: 'test-key', baseUrl: BASE_URL, retry: { maxRetries: 0 } } as const

describe('OpenAI 兼容基线协议', () => {
  it('按标准协议投递到 <baseUrl>/chat/completions，并透传采样参数与 tool_choice', async () => {
    let capturedUrl: string | undefined
    let captured: Record<string, unknown> | undefined
    let capturedInit: RequestInit | undefined

    await callOpenAiCompat(
      {
        model: 'gateway-model',
        messages: [{ role: 'user', content: '你好' }],
        temperature: 0.2,
        top_p: 0.8,
        presence_penalty: 0.1,
        frequency_penalty: 0.3,
        max_tokens: 512,
        tool_choice: { type: 'function', function: { name: 'read_file' } },
        tools: [{
          type: 'function',
          function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
        }],
      },
      {
        ...CALL_OPTIONS,
        // 尾斜杠由底座归一，adapter 不再自己拼路径。
        baseUrl: `${BASE_URL}/`,
        fetchImpl: async (input, init) => {
          capturedUrl = String(input)
          capturedInit = init
          captured = requestBody(init)
          return okResponse()
        },
      },
    )

    expect(capturedUrl).toBe(`${BASE_URL}/chat/completions`)
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(captured).toMatchObject({
      model: 'gateway-model',
      temperature: 0.2,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
      max_tokens: 512,
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    })
    // 非流式请求不注入 stream_options：那只对流式有意义。
    expect(captured).not.toHaveProperty('stream_options')
    expect(captured).not.toHaveProperty('stream')
  })

  it('thinking 开启时不做 DeepSeek 式净化：采样参数与 tool_choice 一并上行', async () => {
    let captured: Record<string, unknown> | undefined

    await callOpenAiCompat(
      {
        model: 'gateway-model',
        messages: [{ role: 'user', content: '分析' }],
        thinking: { type: 'enabled' },
        temperature: 0.7,
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.4,
        tool_choice: 'required',
      },
      {
        ...CALL_OPTIONS,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
      },
    )

    expect(captured).toMatchObject({
      thinking: { type: 'enabled' },
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.2,
      frequency_penalty: 0.4,
      tool_choice: 'required',
    })
  })

  it('不归一 reasoning_content，也不把工具调用轮的 null content 改写成空串', async () => {
    let captured: Record<string, unknown> | undefined
    const messages: OpenAiCompatChatRequest['messages'] = [
      { role: 'user', content: '读取配置' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"config.json"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"enabled":true}' },
    ]

    await callOpenAiCompat(
      { model: 'gateway-model', messages },
      {
        ...CALL_OPTIONS,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
      },
    )

    expect(captured?.messages).toEqual(messages)
    expect((captured?.messages as Record<string, unknown>[])[1])
      .not.toHaveProperty('reasoning_content')
  })

  it('结构化用户内容降级为纯文本，且不修改调用方的 messages', async () => {
    let captured: Record<string, unknown> | undefined
    const messages: OpenAiCompatChatRequest['messages'] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          {
            type: 'image',
            source: { kind: 'provider-file', provider: 'kimi', scope: 'cn', reference: 'ms://f-1' },
            name: 'shot.png',
            mimeType: 'image/png',
            byteSize: 1024,
          },
        ],
      },
    ]

    await callOpenAiCompat(
      { model: 'gateway-model', messages },
      {
        ...CALL_OPTIONS,
        fetchImpl: async (_input, init) => {
          captured = requestBody(init)
          return okResponse()
        },
      },
    )

    const sent = (captured?.messages as { content: string }[])[0]!
    expect(sent.content).toContain('看看这张图')
    expect(sent.content).toContain('shot.png')
    // provider-file 引用绝不上行到第三方端点。
    expect(JSON.stringify(captured)).not.toContain('ms://')
    expect(messages[0]?.content).toBeInstanceOf(Array)
  })

  it('缺少 baseUrl 时以结构化配置错误拒绝，且一个请求都不发', async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    const body: OpenAiCompatChatRequest = {
      model: 'gateway-model',
      messages: [{ role: 'user', content: '没有端点' }],
    }

    // 同步返回 promise（同步抛异常会让这两行直接失败），再以 rejection 暴露错误。
    const call = callOpenAiCompat(body, { apiKey: 'test-key', fetchImpl })
    const stream = streamOpenAiCompat(body, { apiKey: 'test-key', fetchImpl })

    await expect(call).rejects.toBeInstanceOf(OpenAiCompatConfigError)
    await expect(call).rejects.toMatchObject({
      name: 'OpenAiCompatConfigError',
      code: 'missing_base_url',
      message: 'Chat completion requires an explicit baseUrl (missing_base_url).',
    })
    await expect(stream).rejects.toMatchObject({ code: 'missing_base_url' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('空白 baseUrl 与缺失同罪，不会退回任何厂商默认端点', async () => {
    const fetchImpl = vi.fn(async () => okResponse())

    await expect(callOpenAiCompat(
      { model: 'gateway-model', messages: [{ role: 'user', content: '空白端点' }] },
      { apiKey: 'test-key', baseUrl: '   ', fetchImpl },
    )).rejects.toMatchObject({ code: 'missing_base_url' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('流式请求解析 SSE 增量、终止原因与 usage', async () => {
    const deltas: string[] = []

    const result = await streamOpenAiCompat(
      { model: 'gateway-model', messages: [{ role: 'user', content: '流式' }] },
      { ...CALL_OPTIONS, fetchImpl: async () => okStreamResponse() },
      { onDelta: (delta) => deltas.push(delta.content ?? '') },
    )

    expect(deltas).toEqual(['你', '好', ''])
    expect(result.id).toBe('chatcmpl-1')
    expect(result.model).toBe('gateway-model')
    expect(result.choices?.[0]?.message?.content).toBe('你好')
    expect(result.choices?.[0]?.finish_reason).toBe('stop')
    expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 2 })
  })

  it('流式请求累积分片的工具调用参数', async () => {
    const result = await streamOpenAiCompat(
      { model: 'gateway-model', messages: [{ role: 'user', content: '调工具' }] },
      {
        ...CALL_OPTIONS,
        fetchImpl: async () => sseResponse([
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
          '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        ]),
      },
    )

    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
    ])
    expect(result.choices?.[0]?.finish_reason).toBe('tool_calls')
  })

  it('流式默认注入 include_usage，但尊重调用方显式关闭', async () => {
    const captured: Record<string, unknown>[] = []
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(requestBody(init))
      return okStreamResponse()
    }

    await streamOpenAiCompat(
      { model: 'gateway-model', messages: [{ role: 'user', content: '默认' }] },
      { ...CALL_OPTIONS, fetchImpl },
    )
    await streamOpenAiCompat(
      {
        model: 'gateway-model',
        messages: [{ role: 'user', content: '显式关闭' }],
        stream_options: { include_usage: false },
      },
      { ...CALL_OPTIONS, fetchImpl },
    )

    expect(captured[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(captured[1]).toMatchObject({ stream: true, stream_options: { include_usage: false } })
  })
})
