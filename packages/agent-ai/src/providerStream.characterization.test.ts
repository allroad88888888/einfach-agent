import { describe, expect, it } from 'vitest'
import { streamDeepSeek } from './deepseek'
import { streamGlm } from './glm'
import { streamKimi } from './kimi'
import { streamOpenAiCompat } from './openaiCompat'
import {
  normalizeCacheUsage,
  type ChatCallOptions,
  type ChatRequestBase,
  type ChatStreamHandlers,
  type ModelChatResponse,
  type ModelStreamDelta,
  type ModelUsage,
} from './modelApi'

type StreamProvider = (
  body: ChatRequestBase,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
) => Promise<ModelChatResponse>

function fragmentedSseResponse(chunks: unknown[]): Response {
  const source = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`),
    'data: [DONE]\r\n\r\n',
  ].join('')
  const parts = [source.slice(0, 2), source.slice(2, 47), source.slice(47)]
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('provider SSE 与 usage characterization', () => {
  it('DeepSeek 聚合分片 reasoning/content，并接住独立 usage 尾包', async () => {
    const usage: ModelUsage = {
      prompt_tokens: 15,
      completion_tokens: 4,
      total_tokens: 19,
      prompt_cache_hit_tokens: 12,
      prompt_cache_miss_tokens: 3,
    }
    const deltas: ModelStreamDelta[] = []

    const response = await streamDeepSeek(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Explain' }],
      },
      {
        apiKey: 'key',
        baseUrl: 'https://deepseek.example/v1',
        fetchImpl: async () => fragmentedSseResponse([
          {
            id: 'chatcmpl-deepseek',
            model: 'deepseek-v4-pro-observed',
            choices: [{ delta: { role: 'assistant', reasoning_content: '思' } }],
          },
          { choices: [{ delta: { reasoning_content: '考' } }] },
          { choices: [{ delta: { content: '答' } }] },
          { choices: [{ delta: { content: '案' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage },
        ]),
        retry: { maxRetries: 0 },
      },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual([
      { role: 'assistant', reasoning_content: '思' },
      { reasoning_content: '考' },
      { content: '答' },
      { content: '案' },
      {},
    ])
    expect(response).toEqual({
      id: 'chatcmpl-deepseek',
      model: 'deepseek-v4-pro-observed',
      usage,
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '答案',
          reasoning_content: '思考',
        },
      }],
    })
    expect(normalizeCacheUsage(response.usage)).toMatchObject({
      hitTokens: 12,
      missTokens: 3,
      missSource: 'provider',
      totalInputTokens: 15,
    })
  })

  // DeepSeek 是唯一自带 prompt_cache_hit/miss_tokens 计数器的厂商（missSource: 'provider'，
  // 见上一条用例）。GLM/Kimi/OpenAI-compat 都只在 usage 里带 OpenAI 标准的
  // prompt_tokens_details.cached_tokens，缓存未命中量由 normalizeCacheUsage 从
  // total - hit 派生（missSource: 'derived'）。三家共享同一条派生路径，这里用同一批用例
  // 断言住这个已知差异，而不是只在 GLM 一家上验证、对 Kimi/OpenAI-compat 保持沉默。
  const DERIVED_CACHE_PROVIDERS: Array<{
    name: string
    stream: StreamProvider
    model: string
    baseUrl: string
    chunkId: string
    cachedTokens: number
  }> = [
    {
      name: 'GLM',
      stream: streamGlm,
      model: 'glm-5.2',
      baseUrl: 'https://glm.example/v4',
      chunkId: 'chatcmpl-glm',
      cachedTokens: 8,
    },
    {
      name: 'Kimi',
      stream: streamKimi,
      model: 'kimi-k2.6',
      baseUrl: 'https://kimi.example/v1',
      chunkId: 'chatcmpl-kimi',
      cachedTokens: 10,
    },
    {
      name: 'OpenAI-compat',
      stream: streamOpenAiCompat,
      model: 'gateway-model',
      baseUrl: 'https://gateway.example/v1',
      chunkId: 'chatcmpl-gateway',
      cachedTokens: 16,
    },
  ]

  it.each(DERIVED_CACHE_PROVIDERS)(
    '$name 聚合分片文本，并从 cached_tokens 派生缓存命中（不像 DeepSeek 自带 hit/miss 计数器）',
    async ({ stream, model, baseUrl, chunkId, cachedTokens }) => {
      const promptTokens = cachedTokens * 3
      const usage: ModelUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: 2,
        total_tokens: promptTokens + 2,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      }
      const deltas: ModelStreamDelta[] = []

      const response = await stream(
        { model, messages: [{ role: 'user', content: 'Answer' }] },
        {
          apiKey: 'key',
          baseUrl,
          fetchImpl: async () => fragmentedSseResponse([
            {
              id: chunkId,
              model: `${model}-observed`,
              choices: [{ delta: { role: 'assistant', content: '结' } }],
            },
            { choices: [{ delta: { content: '果' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
          ]),
          retry: { maxRetries: 0 },
        },
        { onDelta: (delta) => deltas.push(delta) },
      )

      expect(deltas).toEqual([
        { role: 'assistant', content: '结' },
        { content: '果' },
        {},
      ])
      expect(response.choices?.[0]?.message?.content).toBe('结果')
      expect(response.choices?.[0]?.finish_reason).toBe('stop')
      expect(normalizeCacheUsage(response.usage)).toMatchObject({
        hitTokens: cachedTokens,
        missTokens: promptTokens - cachedTokens,
        missSource: 'derived',
        totalInputTokens: promptTokens,
      })
    },
  )
})
