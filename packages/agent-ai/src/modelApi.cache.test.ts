// Context Caching usage 的共享协议测试。
// ---------------------------------------------------------------------------
// 覆盖三件事：
//   1. OpenAI-compatible 的 stream_options.include_usage 可按 provider 能力选择性发送；
//   2. choices=[] 的流末 usage chunk 会进入最终 ModelChatResponse；
//   3. DeepSeek / GLM / OpenAI 风格的缓存字段归一成同一份 CacheUsage。

import { describe, expect, it } from 'vitest'
import { streamDeepSeek } from './deepseek'
import { streamGlm } from './glm'
import {
  normalizeCacheUsage,
  postChatCompletionStream,
  type ChatRequestBase,
  type ModelUsage,
} from './modelApi'

const BASE_URL = 'https://example.test/v1'
const BODY: ChatRequestBase = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
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

function successfulStream(usage?: ModelUsage): Response {
  const chunks: unknown[] = [
    { choices: [{ delta: { role: 'assistant', content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  if (usage) chunks.push({ choices: [], usage })
  return sseResponse(chunks)
}

// GLM 官方示例把 usage 放在带 finish_reason 的最后一个普通 chunk，而不是 choices=[] 尾包。
function successfulGlmStream(usage: ModelUsage): Response {
  return sseResponse([
    { choices: [{ delta: { role: 'assistant', content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ])
}

describe('流式 usage 请求与响应', () => {
  it('DeepSeek SSE 聚合后保留服务端顶层 id 和 model', async () => {
    const result = await streamDeepSeek(
      { ...BODY, model: 'deepseek-v4-pro' },
      {
        apiKey: 'k',
        fetchImpl: async () => sseResponse([
          {
            id: 'chatcmpl-deepseek-observed',
            model: 'deepseek-v4-pro-20260724',
            choices: [{ delta: { role: 'assistant', content: 'ok' } }],
          },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        retry: { maxRetries: 0 },
      },
    )

    expect(result).toMatchObject({
      id: 'chatcmpl-deepseek-observed',
      model: 'deepseek-v4-pro-20260724',
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    })
  })

  it('透传显式 stream_options，并保留 choices=[] 最终 chunk 的 usage', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const usage: ModelUsage = {
      prompt_tokens: 3085,
      completion_tokens: 10,
      total_tokens: 3095,
      prompt_cache_hit_tokens: 3072,
      prompt_cache_miss_tokens: 13,
    }
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return successfulStream(usage)
    }

    const result = await postChatCompletionStream(
      BASE_URL,
      {
        ...BODY,
        stream_options: { include_usage: true, vendor_flag: 'keep-me' },
      },
      { apiKey: 'k', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true, vendor_flag: 'keep-me' },
    })
    expect(result.usage).toEqual(usage)
    expect(normalizeCacheUsage(result.usage)).toMatchObject({
      hitTokens: 3072,
      missTokens: 13,
      missSource: 'provider',
      totalInputTokens: 3085,
    })
  })

  it('通用底层不向未声明能力的 provider 强塞 stream_options', async () => {
    let captured: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return successfulStream()
    }

    await postChatCompletionStream(BASE_URL, BODY, {
      apiKey: 'k',
      fetchImpl,
      retry: { maxRetries: 0 },
    })

    expect(captured?.stream).toBe(true)
    expect(captured).not.toHaveProperty('stream_options')
  })

  it('DeepSeek 流默认请求 usage，同时保留调用方其它 stream_options', async () => {
    let captured: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return successfulStream()
    }

    await streamDeepSeek(
      { ...BODY, stream_options: { vendor_flag: 'keep-me' } },
      { apiKey: 'k', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(captured?.stream_options).toEqual({
      vendor_flag: 'keep-me',
      include_usage: true,
    })
  })

  it('DeepSeek 尊重显式 include_usage:false', async () => {
    let captured: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return successfulStream()
    }

    await streamDeepSeek(
      { ...BODY, stream_options: { include_usage: false } },
      { apiKey: 'k', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(captured?.stream_options).toEqual({ include_usage: false })
  })

  it('GLM 不注入未文档化的 stream_options，仍接住末块自动返回的 usage', async () => {
    let captured: Record<string, unknown> | undefined
    const usage: ModelUsage = {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 },
    }
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return successfulGlmStream(usage)
    }

    const result = await streamGlm(BODY, {
      apiKey: 'k',
      fetchImpl,
      retry: { maxRetries: 0 },
    })

    expect(captured).not.toHaveProperty('stream_options')
    expect(result.usage).toEqual(usage)
    expect(normalizeCacheUsage(result.usage)).toMatchObject({
      hitTokens: 800,
      missTokens: 400,
      missSource: 'derived',
      totalInputTokens: 1200,
    })
  })
})

describe('normalizeCacheUsage', () => {
  it('优先采用 DeepSeek 顶层 hit/miss，不被冗余 cached_tokens 覆盖', () => {
    expect(
      normalizeCacheUsage({
        prompt_tokens: 3085,
        prompt_cache_hit_tokens: 3072,
        prompt_cache_miss_tokens: 13,
        prompt_tokens_details: { cached_tokens: 2048 },
      }),
    ).toMatchObject({
      hitTokens: 3072,
      missTokens: 13,
      missSource: 'provider',
      totalInputTokens: 3085,
    })
  })

  it('从 GLM/OpenAI Chat 的 prompt_tokens_details.cached_tokens 推导 miss', () => {
    expect(
      normalizeCacheUsage({
        prompt_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toMatchObject({
      hitTokens: 800,
      missTokens: 400,
      missSource: 'derived',
      totalInputTokens: 1200,
    })
  })

  it('兼容 OpenAI Responses 的 input_tokens_details.cached_tokens', () => {
    expect(
      normalizeCacheUsage({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 64 },
      }),
    ).toMatchObject({
      hitTokens: 64,
      missTokens: 36,
      missSource: 'derived',
      totalInputTokens: 100,
    })
  })

  it('容错兼容顶层 cached_tokens', () => {
    expect(normalizeCacheUsage({ prompt_tokens: 100, cached_tokens: 25 })).toMatchObject({
      hitTokens: 25,
      missTokens: 75,
      missSource: 'derived',
      totalInputTokens: 100,
    })
  })

  it('只有 DeepSeek miss 时可由总输入反推 hit', () => {
    expect(normalizeCacheUsage({ prompt_tokens: 100, prompt_cache_miss_tokens: 75 })).toMatchObject({
      hitTokens: 25,
      missTokens: 75,
      missSource: 'provider',
      totalInputTokens: 100,
    })
  })

  it('显式 0 是有效指标，不会被当成字段缺失', () => {
    expect(
      normalizeCacheUsage({
        prompt_tokens: 80,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ).toMatchObject({
      hitTokens: 0,
      missTokens: 80,
      missSource: 'derived',
      totalInputTokens: 80,
    })
  })

  it('total/hit/miss 任一关系矛盾时整组拒绝，不钳成看似合法的 0', () => {
    expect(
      normalizeCacheUsage({
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 11 },
      }),
    ).toBeUndefined()
    expect(
      normalizeCacheUsage({
        prompt_tokens: 10,
        prompt_cache_miss_tokens: 11,
      }),
    ).toBeUndefined()
    expect(
      normalizeCacheUsage({
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 8,
        prompt_cache_miss_tokens: 3,
      }),
    ).toBeUndefined()
  })

  it('只有 hit、没有 total 时保留可证明字段，并把 miss 来源标为 unknown', () => {
    expect(normalizeCacheUsage({ cached_tokens: 25 })).toEqual({
      hitTokens: 25,
      missTokens: undefined,
      missSource: 'unknown',
      writeTokens: undefined,
      totalInputTokens: undefined,
    })
  })

  it('没有 cache-specific 指标时返回 undefined，不把普通 prompt_tokens 当成全 miss', () => {
    expect(normalizeCacheUsage({ prompt_tokens: 100 })).toBeUndefined()
    expect(normalizeCacheUsage(undefined)).toBeUndefined()
  })

  it('忽略负数、Infinity 与字符串形式的无效 cache 指标', () => {
    const malformedUsage = {
      prompt_tokens: 100,
      prompt_cache_hit_tokens: -1,
      prompt_cache_miss_tokens: Number.POSITIVE_INFINITY,
      cached_tokens: '20',
    } as unknown as ModelUsage

    expect(normalizeCacheUsage(malformedUsage)).toBeUndefined()
  })
})
