import { describe, expect, it } from 'vitest'
import { streamDeepSeek } from './deepseek'
import { streamGlm } from './glm'
import {
  normalizeCacheUsage,
  type ModelStreamDelta,
  type ModelUsage,
} from './modelApi'

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

  it('GLM 聚合文本，并接住 finish chunk 同包的 usage', async () => {
    const usage: ModelUsage = {
      prompt_tokens: 20,
      completion_tokens: 2,
      total_tokens: 22,
      prompt_tokens_details: { cached_tokens: 8 },
    }
    const deltas: ModelStreamDelta[] = []

    const response = await streamGlm(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'Answer' }],
      },
      {
        apiKey: 'key',
        baseUrl: 'https://glm.example/v4',
        fetchImpl: async () => fragmentedSseResponse([
          {
            id: 'chatcmpl-glm',
            model: 'glm-5.2-observed',
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
    expect(response).toEqual({
      id: 'chatcmpl-glm',
      model: 'glm-5.2-observed',
      usage,
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '结果' },
      }],
    })
    expect(normalizeCacheUsage(response.usage)).toMatchObject({
      hitTokens: 8,
      missTokens: 12,
      missSource: 'derived',
      totalInputTokens: 20,
    })
  })
})
