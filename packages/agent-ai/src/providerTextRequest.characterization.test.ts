import { describe, expect, it } from 'vitest'
import { callDeepSeek, streamDeepSeek } from './deepseek'
import { callGlm, streamGlm } from './glm'
import { bodyOf, capture, jsonResponse, sseResponse } from './providerRequestCapture'
import type { ChatRequestBase } from './modelApi'

const TEXT_MESSAGES: ChatRequestBase['messages'] = [
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'First question' },
  {
    role: 'assistant',
    content: 'First answer',
    reasoning_content: 'Prior reasoning',
  },
  { role: 'user', content: 'Follow up' },
]

describe('provider 纯文本请求 characterization', () => {
  it('DeepSeek 非流式请求保持字符串消息，并应用 thinking 请求净化', async () => {
    const captured = capture(jsonResponse)

    await callDeepSeek(
      {
        model: 'deepseek-v4-pro',
        messages: TEXT_MESSAGES,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        user_id: 'wa_characterization_01',
        temperature: 0.2,
        top_p: 0.8,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        tool_choice: 'auto',
        max_tokens: 2048,
      },
      {
        apiKey: 'deepseek-secret',
        baseUrl: 'https://deepseek.example/v1/',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    const request = captured.request()
    expect(request.url).toBe('https://deepseek.example/v1/chat/completions')
    expect(request.init.method).toBe('POST')
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer deepseek-secret')
    expect(bodyOf(request.init)).toEqual({
      model: 'deepseek-v4-pro',
      messages: TEXT_MESSAGES,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      max_tokens: 2048,
      user_id: 'wa_characterization_01',
    })
    expect(TEXT_MESSAGES.every((message) => typeof message.content === 'string')).toBe(true)
  })

  it('GLM 非流式请求保持字符串消息并透传公共参数', async () => {
    const captured = capture(jsonResponse)

    await callGlm(
      {
        model: 'glm-5.2',
        messages: TEXT_MESSAGES,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        temperature: 0.7,
        tool_choice: 'required',
        max_tokens: 3072,
      },
      {
        apiKey: 'glm-secret',
        baseUrl: 'https://glm.example/v4/',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    const request = captured.request()
    expect(request.url).toBe('https://glm.example/v4/chat/completions')
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer glm-secret')
    expect(bodyOf(request.init)).toEqual({
      model: 'glm-5.2',
      messages: TEXT_MESSAGES,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      temperature: 0.7,
      tool_choice: 'required',
      max_tokens: 3072,
    })
    expect(TEXT_MESSAGES.every((message) => typeof message.content === 'string')).toBe(true)
  })

  it('DeepSeek 流式请求只增加 stream 与默认 usage 开关', async () => {
    const captured = capture(sseResponse)

    await streamDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: TEXT_MESSAGES,
        stream_options: { vendor_flag: 'keep' },
      },
      {
        apiKey: 'key',
        baseUrl: 'https://deepseek.example/v1',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    expect(bodyOf(captured.request().init)).toEqual({
      model: 'deepseek-v4-flash',
      messages: TEXT_MESSAGES,
      stream_options: { vendor_flag: 'keep', include_usage: true },
      stream: true,
    })
  })

  it('GLM 流式请求只增加 stream，不隐式增加 stream_options', async () => {
    const captured = capture(sseResponse)

    await streamGlm(
      { model: 'glm-5.2', messages: TEXT_MESSAGES },
      {
        apiKey: 'key',
        baseUrl: 'https://glm.example/v4',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    expect(bodyOf(captured.request().init)).toEqual({
      model: 'glm-5.2',
      messages: TEXT_MESSAGES,
      stream: true,
    })
  })
})
