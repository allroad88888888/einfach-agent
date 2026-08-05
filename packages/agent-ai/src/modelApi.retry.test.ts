// modelApi 重试层的测试。
// ---------------------------------------------------------------------------
// 覆盖三条不变量：
//   R1 AbortError 永不重试且原样透传（上层靠它把 run 降级成 'stopped'）；退避等待也可被打断。
//   R2 只重试 429 / 5xx / 网络错误；其它 4xx 立即失败。
//   R3 流式只在「尚未 emit 任何有实际内容的 delta」前重试 —— 已经吐字后重试会让 UI 出现重复内容；
//      首包恒为 {content:""} 的空 delta 不算「吐过字」。
// 除少数专测退避可中断的用例外，都注入 sleepImpl，避免真的等退避时间。

import { describe, it, expect } from 'vitest'
import {
  postChatCompletion,
  postChatCompletionStream,
  DEFAULT_RETRY_CONFIG,
  type ChatCallOptions,
  type ChatRequestBase,
  type RetryConfig,
} from './modelApi'

const BASE_URL = 'https://example.test/v1'
const BODY: ChatRequestBase = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }

function callOptions(fetchImpl: typeof fetch, retry: RetryConfig, signal?: AbortSignal): ChatCallOptions {
  return { apiKey: 'k', fetchImpl, retry, signal }
}

// 记录每次退避的等待时长，并立刻 resolve（测试不真等）。
function recordingSleep(): { delays: number[]; sleepImpl: NonNullable<RetryConfig['sleepImpl']> } {
  const delays: number[] = []
  return {
    delays,
    async sleepImpl(ms: number) {
      delays.push(ms)
    },
  }
}

function okResponse(content = '你好'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`server said ${status}`, { status, headers })
}

// 按次序返回不同结果的 fetch（越界后重复最后一步）；calls() = 已发起的请求次数。
function seqFetch(steps: Array<() => Response>): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0
  const fetchImpl: typeof fetch = async () => {
    const step = steps[Math.min(i, steps.length - 1)]
    i += 1
    return step()
  }
  return { fetchImpl, calls: () => i }
}

function sseBlock(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function deltaChunk(content: string): unknown {
  return { choices: [{ delta: { role: 'assistant', content } }] }
}

// 只携带 reasoning_content（没有 content）的 delta —— 对应「模型正在思考、还没开始正文」的阶段。
function reasoningChunk(reasoning: string): unknown {
  return { choices: [{ delta: { role: 'assistant', reasoning_content: reasoning } }] }
}

// 只携带 tool_calls（没有 content）的 delta —— 对应「模型直接决定调工具、不先说话」的阶段。
function toolCallChunk(name: string, args: string): unknown {
  return {
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function' as const, function: { name, arguments: args } },
          ],
        },
      },
    ],
  }
}

function eventStream(source: UnderlyingDefaultSource<Uint8Array>): Response {
  return new Response(new ReadableStream<Uint8Array>(source), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// 完整的流式响应。
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return eventStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(sseBlock(chunk)))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

// 服务端干净关闭连接但没有发送 [DONE]，用于覆盖协议截断边界。
function sseResponseWithoutDone(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return eventStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(sseBlock(chunk)))
      controller.close()
    },
  })
}

// 原样发送一个 SSE data block，便于分别构造“完整坏 JSON”和“JSON 在 EOF 截断”。
function rawSseResponse(data: string): Response {
  const encoder = new TextEncoder()
  return eventStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      controller.close()
    },
  })
}

// 先真正吐完 chunks、再让 body 报错的流（模拟「说到一半连接断了」）。
// 注意必须用 pull 逐块投递：若在 start() 里 enqueue 完再 controller.error()，
// 排队中的 chunk 会被直接丢弃，读端一个 delta 都收不到 —— 那样测的就不是 R3 了。
function brokenSseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  return eventStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(sseBlock(chunks[i])))
        i += 1
        return
      }
      controller.error(new Error('stream broke'))
    },
  })
}

function collectDeltas(): { texts: string[]; onDelta: (delta: { content?: string | null }) => void } {
  const texts: string[] = []
  return {
    texts,
    onDelta(delta) {
      if (typeof delta.content === 'string') texts.push(delta.content)
    },
  }
}

describe('postChatCompletion 重试（R2：429 / 5xx / 网络错误）', () => {
  it('429 后成功：重试一次，最终拿到正常响应', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(429), () => okResponse('恢复了')])

    const result = await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 10 }),
    )

    expect(result.choices?.[0]?.message?.content).toBe('恢复了')
    expect(calls()).toBe(2)
    expect(delays).toEqual([10])
  })

  it('5xx 后成功：503 → 200', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(503), () => okResponse()])

    await postChatCompletion(BASE_URL, BODY, callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }))

    expect(calls()).toBe(2)
  })

  it('网络错误（fetch 抛错）后成功：重试并拿到结果', async () => {
    const { sleepImpl } = recordingSleep()
    let first = true
    const fetchImpl: typeof fetch = async () => {
      if (first) {
        first = false
        throw new TypeError('Failed to fetch')
      }
      return okResponse('网络恢复')
    }

    const result = await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(result.choices?.[0]?.message?.content).toBe('网络恢复')
  })

  it('HTTP 200 空 JSON 响应会重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([
      () => new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => okResponse('响应恢复'),
    ])

    const result = await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(calls()).toBe(2)
    expect(result.choices?.[0]?.message?.content).toBe('响应恢复')
  })

  it('HTTP 200 截断 JSON 响应会重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([
      () => new Response('{"choices":[', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      () => okResponse('截断后恢复'),
    ])

    const result = await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(calls()).toBe(2)
    expect(result.choices?.[0]?.message?.content).toBe('截断后恢复')
  })

  it('网络错误重试耗尽：保留错误类型但不暴露 fetch 原始详情', async () => {
    const { sleepImpl } = recordingSleep()
    const original = new TypeError('Failed to fetch')
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      throw original
    }

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1, maxRetries: 2 }),
      ),
    ).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Chat completion transport failed (network_error).',
    })

    expect(attempts).toBe(3) // 首次 + 2 次重试
  })

  it('4xx（401）绝不重试：只发一次请求，错误带回服务端 detail', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(401)])

    await expect(
      postChatCompletion(BASE_URL, BODY, callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 })),
    ).rejects.toThrow(/401/)

    expect(calls()).toBe(1)
  })

  it('重试耗尽后抛 HTTP 错误：总请求数 = 1 + maxRetries', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(500)])

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1, maxRetries: 3 }),
      ),
    ).rejects.toThrow(/500/)

    expect(calls()).toBe(4)
    expect(delays).toHaveLength(3)
  })

  it('maxRetries: 0 关闭重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(500)])

    await expect(
      postChatCompletion(BASE_URL, BODY, callOptions(fetchImpl, { sleepImpl, maxRetries: 0 })),
    ).rejects.toThrow(/500/)

    expect(calls()).toBe(1)
  })

  it('成功路径不产生任何退避', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => okResponse('一次就好')])

    const result = await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(result.choices?.[0]?.message?.content).toBe('一次就好')
    expect(calls()).toBe(1)
    expect(delays).toEqual([])
  })
})

describe('退避与 Retry-After', () => {
  it('指数增长：关掉 jitter 后为 base * 2^n', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([() => errorResponse(500)])

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 10, maxRetries: 3 }),
      ),
    ).rejects.toThrow()

    expect(delays).toEqual([10, 20, 40])
  })

  it('maxDelayMs 封顶指数增长', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([() => errorResponse(500)])

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, {
          sleepImpl,
          jitter: false,
          baseDelayMs: 100,
          maxDelayMs: 150,
          maxRetries: 3,
        }),
      ),
    ).rejects.toThrow()

    expect(delays).toEqual([100, 150, 150])
  })

  it('jitter 开启时落在 [delay/2, delay] 区间内', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([() => errorResponse(500)])

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, jitter: true, baseDelayMs: 1000, maxRetries: 1 }),
      ),
    ).rejects.toThrow()

    expect(delays[0]).toBeGreaterThanOrEqual(500)
    expect(delays[0]).toBeLessThanOrEqual(1000)
  })

  it('Retry-After（秒数）优先于指数退避', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([
      () => errorResponse(429, { 'Retry-After': '2' }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 10 }),
    )

    expect(delays).toEqual([2000]) // 2 秒，而非 baseDelayMs 的 10ms
  })

  it('Retry-After（HTTP date）换算成相对毫秒', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const future = new Date(Date.now() + 3000).toUTCString()
    const { fetchImpl } = seqFetch([
      () => errorResponse(503, { 'Retry-After': future }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 10 }),
    )

    // HTTP date 只有秒精度，允许落差。
    expect(delays[0]).toBeGreaterThan(1000)
    expect(delays[0]).toBeLessThanOrEqual(3000)
  })

  it('Retry-After 被 maxDelayMs 钳住（避免 300s 把 agent 挂死）', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([
      () => errorResponse(429, { 'Retry-After': '300' }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 10, maxDelayMs: 5000 }),
    )

    expect(delays).toEqual([5000])
  })

  it('Retry-After: 0 不会零间隔连打，至少退避 baseDelayMs（回归：曾经直接 return 0）', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([
      () => errorResponse(429, { 'Retry-After': '0' }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 50, maxDelayMs: 5000 }),
    )

    // 之前的实现是 Math.min(retryAfterMs, maxDelayMs) —— Retry-After: 0 会让它原样返回 0，
    // 等于零间隔重发，对着正在限流的服务端再打一下。修复后应钳到 baseDelayMs。
    expect(delays).toEqual([50])
  })

  it('Retry-After 是已过期的 HTTP-date（换算出 0 或负数）同样钳到 baseDelayMs', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const past = new Date(Date.now() - 5000).toUTCString()
    const { fetchImpl } = seqFetch([
      () => errorResponse(503, { 'Retry-After': past }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 50, maxDelayMs: 5000 }),
    )

    expect(delays).toEqual([50])
  })

  it('无法解析的 Retry-After 回退到指数退避', async () => {
    const { delays, sleepImpl } = recordingSleep()
    const { fetchImpl } = seqFetch([
      () => errorResponse(429, { 'Retry-After': 'not-a-date' }),
      () => okResponse(),
    ])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, jitter: false, baseDelayMs: 25 }),
    )

    expect(delays).toEqual([25])
  })

  it('onRetry 回调报告次数/延迟/原因', async () => {
    const { sleepImpl } = recordingSleep()
    const seen: Array<{ attempt: number; delayMs: number; reason: string }> = []
    const { fetchImpl } = seqFetch([() => errorResponse(500), () => okResponse()])

    await postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, {
        sleepImpl,
        jitter: false,
        baseDelayMs: 10,
        onRetry: (info) =>
          seen.push({ attempt: info.attempt, delayMs: info.delayMs, reason: info.reason }),
      }),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.attempt).toBe(1)
    expect(seen[0]?.delayMs).toBe(10)
    expect(seen[0]?.reason).toMatch(/500/)
  })

  it('默认配置：3 次重试 / 500ms 基准', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3)
    expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(500)
  })
})

describe('R1：AbortError 永不重试且原样透传', () => {
  it('fetch 抛 AbortError → 直接透传，不重试', async () => {
    const { sleepImpl } = recordingSleep()
    const abortErr = new DOMException('aborted', 'AbortError')
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      throw abortErr
    }

    await expect(
      postChatCompletion(BASE_URL, BODY, callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 })),
    ).rejects.toBe(abortErr)

    expect(attempts).toBe(1)
  })

  it('退避等待期间被 abort → 抛 AbortError，不再发第二次请求', async () => {
    const controller = new AbortController()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(500)])

    // 这里故意用默认 sleep（真等），以验证等待可被 signal 打断。
    const promise = postChatCompletion(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { jitter: false, baseDelayMs: 400 }, controller.signal),
    )

    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls()).toBe(1)
  })

  it('signal 已 abort 时退避立即抛 AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(429)])

    await expect(
      postChatCompletion(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { baseDelayMs: 5000 }, controller.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(calls()).toBe(1)
  })
})

describe('postChatCompletionStream 重试（R3：只在 emit 任何 delta 之前）', () => {
  it('连接阶段 503 → 重试成功，delta 只吐一遍', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([
      () => errorResponse(503),
      () => sseResponse([deltaChunk('你'), deltaChunk('好')]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(texts).toEqual(['你', '好'])
    expect(result.choices?.[0]?.message?.content).toBe('你好')
  })

  it('连接阶段 429 也会重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([
      () => errorResponse(429, { 'Retry-After': '0' }),
      () => sseResponse([deltaChunk('ok')]),
    ])

    await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(texts).toEqual(['ok'])
  })

  it('★ 已吐出 delta 后流断掉 → 绝不重试，错误抛给上层（UI 不会出现重复内容）', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    // 第一次：吐两个 delta 后断流；第二次若被调用会给出完整内容 —— 一旦重试就会看到重复。
    const { fetchImpl, calls } = seqFetch([
      () => brokenSseResponse([deltaChunk('前'), deltaChunk('半')]),
      () => sseResponse([deltaChunk('前'), deltaChunk('半'), deltaChunk('后半')]),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        { onDelta },
      ),
    ).rejects.toThrow()

    expect(calls()).toBe(1) // 没有第二次请求
    expect(texts).toEqual(['前', '半']) // 只吐了一遍，没有重复
  })

  it('★ 只吐了 reasoning_content（没有 content）就断流 → 同样绝不重试（emitted 的判定不能只看 content）', async () => {
    const { sleepImpl } = recordingSleep()
    // 第一次：只吐一段思维链就断流；第二次若被调用会给出完整内容 —— 一旦重试，最终条目里
    // 就会出现重复的思维链（reasoningContent 是 createAssistantStreamWriter 里的闭包变量，
    // 整次调用只创建一次，重试的第二轮会把新 reasoning 接在旧的后面）。
    const { fetchImpl, calls } = seqFetch([
      () => brokenSseResponse([reasoningChunk('让我想想')]),
      () => sseResponse([deltaChunk('不该被调用')]),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        {},
      ),
    ).rejects.toThrow()

    expect(calls()).toBe(1) // 没有第二次请求 —— 证明只吐 reasoning_content 也算「已吐字」
  })

  it('★ 只吐了 tool_calls（没有 content）就断流 → 同样绝不重试', async () => {
    const { sleepImpl } = recordingSleep()
    // 第一次：只吐一个 tool_calls delta 就断流；第二次若被调用同样代表发生了重试。
    const { fetchImpl, calls } = seqFetch([
      () => brokenSseResponse([toolCallChunk('search', '{"q":"x"}')]),
      () => sseResponse([deltaChunk('不该被调用')]),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        {},
      ),
    ).rejects.toThrow()

    expect(calls()).toBe(1) // 没有第二次请求 —— 证明只吐 tool_calls 也算「已吐字」
  })

  it('尚未吐出任何 delta 时流断掉 → 可以安全重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([
      () => brokenSseResponse([]), // 连上了但一个 delta 都没吐就断了
      () => sseResponse([deltaChunk('重来一次')]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(texts).toEqual(['重来一次'])
    expect(result.choices?.[0]?.message?.content).toBe('重来一次')
  })

  it('clean EOF 且没有 [DONE]：尚未 emit 时按截断重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([
      () => sseResponseWithoutDone([]),
      () => sseResponse([deltaChunk('完整响应')]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(calls()).toBe(2)
    expect(result.choices?.[0]?.message?.content).toBe('完整响应')
  })

  it('clean EOF 且没有 [DONE]：已经 emit 后直接失败，不重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([
      () => sseResponseWithoutDone([deltaChunk('已显示')]),
      () => sseResponse([deltaChunk('不该被调用')]),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        { onDelta },
      ),
    ).rejects.toThrow(/before \[DONE\]/)

    expect(calls()).toBe(1)
    expect(texts).toEqual(['已显示'])
  })

  it('finish chunk 后、最终 usage 与 [DONE] 前 clean EOF：尚未 emit 时可重试', async () => {
    const { sleepImpl } = recordingSleep()
    const usage = {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 2,
    }
    const { fetchImpl, calls } = seqFetch([
      () => sseResponseWithoutDone([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      () =>
        sseResponse([
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage },
        ]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(calls()).toBe(2)
    expect(result.usage).toEqual(usage)
  })

  it('完整但非法的 SSE JSON 是确定性错误，不重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([
      () => rawSseResponse('{"choices": invalid}'),
      () => sseResponse([deltaChunk('不该被调用')]),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      ),
    ).rejects.toThrow(SyntaxError)

    expect(calls()).toBe(1)
  })

  it('SSE JSON 在 EOF 截断且尚未 emit 时可重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([
      () => rawSseResponse('{"choices":['),
      () => sseResponse([deltaChunk('截断后恢复')]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
    )

    expect(calls()).toBe(2)
    expect(result.choices?.[0]?.message?.content).toBe('截断后恢复')
  })

  it('首包是恒定的空 delta（{content:""}）不算「已吐字」，之后断流仍可重试（回归：曾经 if(delta) 一律置 emitted=true）', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const emptyFirstChunk = { choices: [{ delta: { role: 'assistant', content: '' } }] }
    // 第一次连接：只吐出 OpenAI 兼容流恒定的空首包，然后断流；
    // 若 emitted 被误判为 true，这里就不会有第二次请求，整体直接失败。
    const { fetchImpl, calls } = seqFetch([
      () => brokenSseResponse([emptyFirstChunk]),
      () => sseResponse([deltaChunk('真实内容')]),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(result.choices?.[0]?.message?.content).toBe('真实内容')
    // 空首包依然原样透传给了 handlers（对界面无影响），只是不计入 R3 的 emitted 判定。
    expect(texts).toEqual(['', '真实内容'])
  })

  it('流式 4xx 不重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(400)])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        {},
      ),
    ).rejects.toThrow(/400/)

    expect(calls()).toBe(1)
  })

  it('流式 AbortError 透传且不重试', async () => {
    const { sleepImpl } = recordingSleep()
    const abortErr = new DOMException('aborted', 'AbortError')
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      throw abortErr
    }

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        {},
      ),
    ).rejects.toBe(abortErr)

    expect(attempts).toBe(1)
  })

  it('非 SSE 响应（Content-Type 不是 event-stream）走整包回退，连接阶段仍可重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([() => errorResponse(502), () => okResponse('整包')])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(texts).toEqual(['整包'])
    expect(result.choices?.[0]?.message?.content).toBe('整包')
  })

  it('非 SSE 回退分支的普通坏 JSON 不重试', async () => {
    const { sleepImpl } = recordingSleep()
    // Content-Type 不是 text/event-stream，走整包回退分支；body 是坏 JSON（网关错误页常见）。
    const { fetchImpl, calls } = seqFetch([
      () => new Response('not-json{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ])

    await expect(
      postChatCompletionStream(
        BASE_URL,
        BODY,
        callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
        {},
      ),
    ).rejects.toThrow(SyntaxError)

    // 回归点：修复前 json() 解析错误会被包成 RetriableError，在默认 maxRetries=3 下
    // 白白多发 3 次必然还是失败的请求；修复后应该 1 次就终结。
    expect(calls()).toBe(1)
  })

  it('非 SSE 回退分支的空 JSON 响应会在 emit 前安全重试', async () => {
    const { sleepImpl } = recordingSleep()
    const { texts, onDelta } = collectDeltas()
    const { fetchImpl, calls } = seqFetch([
      () => new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => okResponse('回退恢复'),
    ])

    const result = await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      { onDelta },
    )

    expect(calls()).toBe(2)
    expect(texts).toEqual(['回退恢复'])
    expect(result.choices?.[0]?.message?.content).toBe('回退恢复')
  })

  it('请求体强制带 stream:true（重试后依然如此）', async () => {
    const { sleepImpl } = recordingSleep()
    const bodies: string[] = []
    let first = true
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ''))
      if (first) {
        first = false
        return errorResponse(500)
      }
      return sseResponse([deltaChunk('hi')])
    }

    await postChatCompletionStream(
      BASE_URL,
      BODY,
      callOptions(fetchImpl, { sleepImpl, baseDelayMs: 1 }),
      {},
    )

    expect(bodies).toHaveLength(2)
    for (const raw of bodies) {
      expect(JSON.parse(raw)).toMatchObject({ stream: true, model: 'test-model' })
    }
  })
})
