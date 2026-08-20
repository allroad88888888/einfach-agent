import { describe, expect, it } from 'vitest'
import { callKimi, streamKimi } from './kimi'
import { callOpenAiCompat, streamOpenAiCompat } from './openaiCompat'
import { bodyOf, capture, jsonResponse, sseResponse } from './providerRequestCapture'
import type { ChatRequestBase } from './modelApi'
import type { UserImageContentBlock } from './modelProtocol'

// 与 providerTextRequest.characterization.test.ts 是同一组共形测试的两半：那一份钉住
// DeepSeek/GLM 的净化基线，这一份专门钉住 Kimi 与 OpenAI-compat 相对那条基线的两个已知、
// 刻意的差异——不是拿 it.skip 绕过，而是逐条断言成具体的请求形状：
//   · Kimi 换的是整套 wire item 编码（图片块 → image_url，ms:// 原样上行；四个采样参数
//     无条件丢弃，不像 DeepSeek 只在 thinking 开启时丢）；
//   · OpenAI-compat 没有默认接入点（缺 baseUrl 直接拒绝），且不做任何厂商私有净化——
//     请求体与调用方传入的形状逐字一致；图片块经 nonVisualMessages 降级成文本占位，
//     这一点与 GLM/DeepSeek 同组，只是与 Kimi 相反。

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

const KIMI_IMAGE_BLOCK: UserImageContentBlock = {
  type: 'image',
  source: { kind: 'provider-file', provider: 'kimi', scope: 'kimi:cn', reference: 'ms://file-1' },
  name: 'shot.png',
  mimeType: 'image/png',
  byteSize: 2048,
}

describe('provider 请求形状 characterization：Kimi 与 OpenAI-compat 的已知差异', () => {
  it(
    'Kimi 非流式请求无条件丢弃四个采样参数（不像 DeepSeek 只在 thinking 开启时丢），'
      + '并把图片块编码成 ms:// image_url',
    async () => {
      const captured = capture(jsonResponse)
      const messages: ChatRequestBase['messages'] = [
        { role: 'system', content: 'You are concise.' },
        {
          role: 'user',
          content: [{ type: 'text', text: '看看这张图' }, KIMI_IMAGE_BLOCK],
        },
      ]

      await callKimi(
        {
          model: 'kimi-k2.6',
          messages,
          temperature: 0.3,
          top_p: 0.8,
          presence_penalty: 0.1,
          frequency_penalty: 0.2,
          max_tokens: 1024,
        },
        {
          apiKey: 'kimi-secret',
          baseUrl: 'https://kimi.example/v1/',
          fetchImpl: captured.fetchImpl,
          retry: { maxRetries: 0 },
        },
      )

      const request = captured.request()
      expect(request.url).toBe('https://kimi.example/v1/chat/completions')
      expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer kimi-secret')
      const body = bodyOf(request.init)
      expect(body).toEqual({
        model: 'kimi-k2.6',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: 'You are concise.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '看看这张图' },
              { type: 'image_url', image_url: { url: 'ms://file-1' } },
            ],
          },
        ],
      })
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('top_p')
      expect(body).not.toHaveProperty('presence_penalty')
      expect(body).not.toHaveProperty('frequency_penalty')
    },
  )

  it('Kimi 流式请求只增加 stream 与默认 usage 开关（与 DeepSeek 同源，不同于 GLM）', async () => {
    const captured = capture(sseResponse)

    await streamKimi(
      { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] },
      {
        apiKey: 'key',
        baseUrl: 'https://kimi.example/v1',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    expect(bodyOf(captured.request().init)).toEqual({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'hi' }],
      stream_options: { include_usage: true },
      stream: true,
    })
  })

  it('OpenAI-compat 缺少 baseUrl 时拒绝且一个请求都不发；给定 baseUrl 后不做任何厂商私有净化', async () => {
    const captured = capture(jsonResponse)

    await expect(callOpenAiCompat(
      { model: 'gateway-model', messages: TEXT_MESSAGES },
      { apiKey: 'key', fetchImpl: captured.fetchImpl, retry: { maxRetries: 0 } },
    )).rejects.toMatchObject({ code: 'missing_base_url' })

    // thinking 开启的同一份请求，DeepSeek 会剥掉四个采样参数与 tool_choice（见
    // providerTextRequest.characterization.test.ts 的第一条用例）；OpenAI-compat 没有厂商
    // quirk 可净化，原样上行。
    await callOpenAiCompat(
      {
        model: 'gateway-model',
        messages: TEXT_MESSAGES,
        thinking: { type: 'enabled' },
        temperature: 0.7,
        top_p: 0.8,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        tool_choice: 'required',
        max_tokens: 4096,
      },
      {
        apiKey: 'compat-secret',
        baseUrl: 'https://gateway.example/v1/',
        fetchImpl: captured.fetchImpl,
        retry: { maxRetries: 0 },
      },
    )

    const request = captured.request()
    expect(request.url).toBe('https://gateway.example/v1/chat/completions')
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer compat-secret')
    expect(bodyOf(request.init)).toEqual({
      model: 'gateway-model',
      messages: TEXT_MESSAGES,
      thinking: { type: 'enabled' },
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      tool_choice: 'required',
      max_tokens: 4096,
    })
  })

  it(
    'OpenAI-compat 流式请求默认注入 include_usage，且把图片块降级成文本占位'
      + '（不像 Kimi 转发 ms:// 引用）',
    async () => {
      const captured = capture(sseResponse)

      await streamOpenAiCompat(
        {
          model: 'gateway-model',
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: '看看这张图' }, KIMI_IMAGE_BLOCK],
          }],
        },
        {
          apiKey: 'key',
          baseUrl: 'https://gateway.example/v1',
          fetchImpl: captured.fetchImpl,
          retry: { maxRetries: 0 },
        },
      )

      const body = bodyOf(captured.request().init)
      expect(body.stream).toBe(true)
      expect((body.stream_options as Record<string, unknown>).include_usage).toBe(true)
      const sentMessage = (body.messages as { content: string }[])[0]!
      expect(typeof sentMessage.content).toBe('string')
      expect(sentMessage.content).toContain('看看这张图')
      expect(sentMessage.content).toContain('shot.png')
      // provider-file 引用绝不能上行到第三方端点。
      expect(JSON.stringify(body)).not.toContain('ms://')
    },
  )
})
