// P-R2 最小单轮 run 的单测（红→绿）。
// ---------------------------------------------------------------------------
// 契约 U5：只 input→model→reply（不做 lazy tools/多 agent/pipeline）。
// 契约 U7：signal 全穿透 + 失败降级（AbortError→stopped；其它→error），绝不抛崩。
// 只依赖状态层 + api 层；mock fetchImpl 注入模型响应/异常。

import { afterEach, describe, expect, it } from 'vitest'
import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { toolActivityAtom, alwaysAllowedToolsAtom, runtimeTranscriptEventsAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import type { ModelSettings } from '../state/core.type'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'

afterEach(() => {
  resetObservability()
  resetRootStore()
  resetSessionStores()
})

// 在 rootStore 登记一个会话（ghost guard 的权威事实）。
function seedSession(id: string, settings: ModelSettings): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings, createdAt: Date.now(), updatedAt: Date.now() },
  }))
}

// 非流式响应：postChatCompletion 走 res.json()。
function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// 一次「tool_calls」轮响应：content:null + tool_calls（id 可选——省略时校验 runtime 自造 id 回填）。
function toolCallsResponse(calls: Array<{ name: string; args: unknown; id?: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              ...(c.id ? { id: c.id } : {}),
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// 按调用次序返回不同 Response（越界后固定返回最后一个 maker）；count() = 已发起请求次数。
function seqFetch(makers: Array<() => Response>): { fetchImpl: typeof fetch; count: () => number } {
  let i = 0
  const fetchImpl: typeof fetch = async () => {
    const maker = makers[Math.min(i, makers.length - 1)]
    i += 1
    return maker()
  }
  return { fetchImpl, count: () => i }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function captureTrace(): { spans: TraceSpan[]; events: TraceEvent[]; driver: TraceDriver } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    driver: {
      async writeSpan(span) {
        spans.push(clone(span))
      },
      async writeEvent(event) {
        events.push(clone(event))
      },
    },
  }
}

function sseBlock(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(sseBlock(chunk)))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('runSession（P-R2 最小单轮 run）', () => {
  it('跑通一轮：append user → 调 model → append assistant → commit checkpoint → done', async () => {
    seedSession('s1', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('你好')

    await runSession('s1', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = getSessionStore('s1').store.getter(itemsAtom)
    expect(items).toHaveLength(2)
    expect(items[0].item).toEqual({ role: 'user', content: 'hi' })
    expect(items[1].item).toEqual({ role: 'assistant', content: '你好' })

    expect(getSessionStore('s1').store.getter(runAtom)?.status).toBe('done')
    expect(getSessionStore('s1').store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('abort：fetchImpl 抛 AbortError → run.status=stopped，不抛崩', async () => {
    seedSession('s2', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException('aborted', 'AbortError')
    }

    await expect(
      runSession('s2', 'hi', {
        signal: new AbortController().signal,
        apiKey: 'k',
        fetchImpl,
      }),
    ).resolves.toBeUndefined()

    expect(getSessionStore('s2').store.getter(runAtom)?.status).toBe('stopped')
    // 只有 user 一条（assistant 未写回）。
    expect(getSessionStore('s2').store.getter(itemsAtom)).toHaveLength(1)
  })

  it('其它错误：fetchImpl 抛普通 Error → run.status=error（降级不崩）', async () => {
    seedSession('s3', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => {
      throw new Error('boom')
    }

    await expect(
      runSession('s3', 'hi', {
        signal: new AbortController().signal,
        apiKey: 'k',
        fetchImpl,
      }),
    ).resolves.toBeUndefined()

    const run = getSessionStore('s3').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('boom')
  })

  it('未登记会话：runSession 不崩、无任何写入', async () => {
    let called = false
    const fetchImpl: typeof fetch = async () => {
      called = true
      return jsonResponse('不该到这')
    }

    await expect(
      runSession('sX', 'hi', {
        signal: new AbortController().signal,
        apiKey: 'k',
        fetchImpl,
      }),
    ).resolves.toBeUndefined()

    // ghost guard：既不写内容、也不发请求。
    expect(called).toBe(false)
    expect(getSessionStore('sX').store.getter(itemsAtom)).toHaveLength(0)
    expect(getSessionStore('sX').store.getter(runAtom)).toBeUndefined()
  })

  it('vendor=glm：同样跑通一轮', async () => {
    seedSession('s4', { vendor: 'glm', model: 'glm-x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('hi from glm')

    await runSession('s4', 'q', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = getSessionStore('s4').store.getter(itemsAtom)
    expect(items).toHaveLength(2)
    expect(items[1].item).toEqual({ role: 'assistant', content: 'hi from glm' })
    expect(getSessionStore('s4').store.getter(runAtom)?.status).toBe('done')
  })

  it('settings 转发：会话可调参数（temperature/thinking/reasoning_effort）进入 model 请求体', async () => {
    seedSession('s5', {
      vendor: 'deepseek',
      model: 'm',
      temperature: 0.5,
      thinking: true,
      reasoning_effort: 'high',
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession('s5', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(captured.model).toBe('m')
    expect(captured.temperature).toBe(0.5)
    expect(captured.thinking).toEqual({ type: 'enabled' })
    expect(captured.reasoning_effort).toBe('high')
  })

  it('system/tools 注入写入 UI transcript，但不进入 itemsAtom 历史', async () => {
    seedSession('inject1', { vendor: 'deepseek', model: 'm' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession('inject1', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const store = getSessionStore('inject1').store
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'system')).toBe(false)

    const messages = captured.messages as Array<{ role: string; content?: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('已加载 skills：')
    expect(messages.slice(1).map((item) => item.role)).toEqual(['user'])

    const events = store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.kind === 'system_injection' && event.detail?.includes('已加载 skills：'))).toBe(
      true,
    )
    expect(events.some((event) => event.kind === 'tool_manifest' && event.detail?.includes('request_tool_schema'))).toBe(
      true,
    )
  })

  it('空回复：model 返回空 content → error，不写空 assistant、不 commit checkpoint', async () => {
    seedSession('s6', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    await runSession('s6', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const run = getSessionStore('s6').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('模型返回空回复')
    // 不写空 assistant 条目（只留 user 一条）。
    const items = getSessionStore('s6').store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'assistant')).toBe(false)
    // 空回复不算成功一轮：不 commit checkpoint。
    expect(getSessionStore('s6').store.getter(checkpointsAtom)).toHaveLength(0)
  })

  it('stale-run：本次 run 被新 run 顶掉后，迟到的写回不污染新 run', async () => {
    seedSession('s1', { vendor: 'deepseek', model: 'x' })
    // fetchImpl：在返回响应之前先模拟被新 run 顶掉（同会话再次发消息）。
    const fetchImpl: typeof fetch = async () => {
      setRun('s1', { runId: 'OTHER', status: 'running' })
      return jsonResponse('迟到')
    }

    await runSession('s1', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    // 守卫生效：新 run（OTHER/running）未被旧 run 覆盖成 done。
    const run = getSessionStore('s1').store.getter(runAtom)
    expect(run?.runId).toBe('OTHER')
    expect(run?.status).toBe('running')
    // 旧 run 迟到的 assistant '迟到' 未写入（isCurrentRun 拦下）。
    const items = getSessionStore('s1').store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'assistant' && it.item.content === '迟到')).toBe(false)
  })

  it('esc race：fetch 在 abort 前已返回但 signal 已中断 → stopped，不写回 assistant', async () => {
    seedSession('s1', { vendor: 'deepseek', model: 'x' })
    const controller = new AbortController()
    // fetchImpl：在返回 Response 之前先 abort（模拟 esc 恰在 fetch 返回前触发）。
    // runId 未变 → isCurrentRun 仍 true，只有 signal.aborted 能识别这次 esc。
    const fetchImpl: typeof fetch = async () => {
      controller.abort()
      return jsonResponse('迟到的回复')
    }

    await runSession('s1', 'hi', {
      signal: controller.signal,
      apiKey: 'k',
      fetchImpl,
    })

    // esc race 守卫生效：run 落到 stopped（不是 done）。
    expect(getSessionStore('s1').store.getter(runAtom)?.status).toBe('stopped')
    // 迟到的 assistant 未写回。
    const items = getSessionStore('s1').store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'assistant' && it.item.content === '迟到的回复')).toBe(false)
    // 未成功一轮：不 commit checkpoint。
    expect(getSessionStore('s1').store.getter(checkpointsAtom)).toHaveLength(0)
  })
})

describe('runSession（多轮 lazy-tool 循环，T-6）', () => {
  it('无工具单轮：与旧单轮等价（user+assistant、done、checkpoint 长 1）', async () => {
    seedSession('t0', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('直接答')

    await runSession('t0', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t0').store
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    expect(items[1].item).toEqual({ role: 'assistant', content: '直接答' })
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('流式文本：收到 delta 先写 pending assistant，结束后同一条消息变完整并 done', async () => {
    seedSession('stream-text', { vendor: 'deepseek', model: 'x' })
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )

    const runPromise = runSession('stream-text', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    await waitUntil(() => controller !== undefined, 'stream controller')
    controller!.enqueue(encoder.encode(sseBlock({ choices: [{ delta: { content: '你' } }] })))

    await waitUntil(
      () => getSessionStore('stream-text').store.getter(itemsAtom).some((it) => it.item.role === 'assistant'),
      'streamed assistant item',
    )
    const during = getSessionStore('stream-text').store.getter(itemsAtom)
    const assistantId = during.find((it) => it.item.role === 'assistant')?.id
    expect(during.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    expect(during[1]).toMatchObject({ id: assistantId, pending: true, item: { role: 'assistant', content: '你' } })

    controller!.enqueue(encoder.encode(sseBlock({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] })))
    controller!.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller!.close()
    await runPromise

    const done = getSessionStore('stream-text').store.getter(itemsAtom)
    expect(done).toHaveLength(2)
    expect(done[1]).toMatchObject({ id: assistantId, pending: false, item: { role: 'assistant', content: '你好' } })
    expect(getSessionStore('stream-text').store.getter(runAtom)?.status).toBe('done')
    expect(getSessionStore('stream-text').store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('流式 tool_calls：分片 arguments 拼完整后，复用现有工具循环', async () => {
    seedSession('stream-tools', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc1',
                      type: 'function',
                      function: { name: 'request_tool_schema', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"toolName":"skill_' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'search","reason":"x"}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      () => jsonResponse('最终答案'),
    ])

    await runSession('stream-tools', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('stream-tools').store
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const asstTc = items[1].item
    const toolItem = items[2].item
    if (asstTc.role !== 'assistant' || toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(asstTc.tool_calls?.[0].function.arguments).toBe('{"toolName":"skill_search","reason":"x"}')
    expect(toolItem.tool_call_id).toBe('tc1')
    expect(toolItem.content.includes('skill_search')).toBe(true)
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('request_tool_schema：先请求 schema（懒加载）再给最终答案', async () => {
    seedSession('t1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: 'x' } }]),
      () => jsonResponse('最终答案'),
    ])

    await runSession('t1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t1').store
    const items = store.getter(itemsAtom)
    // user → assistant(tool_calls) → tool(schema) → assistant(final)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])

    const asstTc = items[1].item
    const toolItem = items[2].item
    if (asstTc.role !== 'assistant' || toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(asstTc.tool_calls?.[0].function.name).toBe('request_tool_schema')
    // 缺省 id 由 runtime 自造并一致回填：assistant.tool_calls[0].id === tool.tool_call_id。
    expect(asstTc.tool_calls?.[0].id).toBe(toolItem.tool_call_id)
    // schema 已懒加载进 tool result。
    expect(toolItem.content.includes('skill_search')).toBe(true)

    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
    expect((items[3].item as { content?: string }).content).toBe('最终答案')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('runtime tool：加载 skill_search 后调用它，tool result 含 results', async () => {
    seedSession('t2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: '需要搜索' } }]),
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'chart' } }]),
      () => jsonResponse('搜索完成'),
    ])

    await runSession('t2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const items = getSessionStore('t2').store.getter(itemsAtom)
    // user → asst(tc schema) → tool(schema) → asst(tc skill_search) → tool(results) → asst(final)
    expect(items.map((it) => it.item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const searchResult = items[4].item
    if (searchResult.role !== 'tool') throw new Error('意外的条目形状')
    expect(searchResult.content.includes('results')).toBe(true)
    expect(getSessionStore('t2').store.getter(runAtom)?.status).toBe('done')
  })

  it('observability：成功工具轮记录脱敏 payload shape 和可读 preview', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('obs1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: '需要搜索' } }]),
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'chart' }, id: 'search1' }]),
      () => jsonResponse('搜索完成'),
    ])

    await runSession('obs1', 'hi apiKey=plain-secret', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    expect(trace.spans.some((span) => span.name === 'agent.turn' && span.status === 'ok')).toBe(true)
    const llmSpans = trace.spans.filter((span) => span.name === 'llm.chat' && span.status === 'ok')
    expect(llmSpans).toHaveLength(3)
    const firstRequestPreview = String(llmSpans[0]?.attrs?.requestPreview)
    const finalResponsePreview = String(llmSpans[2]?.attrs?.responsePreview)
    expect(firstRequestPreview).toContain('"model":"x"')
    expect(firstRequestPreview).toContain('"messages"')
    expect(firstRequestPreview).toContain('"role":"user"')
    expect(firstRequestPreview).toContain('hi apiKey=[REDACTED]')
    expect(firstRequestPreview).toContain('"tools"')
    expect(firstRequestPreview).toContain('"tool_choice":"auto"')
    expect(firstRequestPreview).toContain('"stream":true')
    expect(firstRequestPreview).not.toContain('plain-secret')
    expect(finalResponsePreview).toContain('"choices"')
    expect(finalResponsePreview).toContain('搜索完成')
    const toolSpan = trace.spans.find(
      (span) =>
        span.name === 'tool.call' &&
        span.status === 'ok' &&
        span.attrs?.toolName === 'skill_search' &&
        span.attrs?.callId === 'search1',
    )
    expect(toolSpan?.attrs).toMatchObject({
      result_kind: 'object',
      args: { redacted: true, kind: 'object', keys: 1 },
      result: { redacted: true, kind: 'object', keys: 2 },
    })
    expect(toolSpan?.attrs?.argsPreview).toContain('"query":"chart"')
    expect(toolSpan?.attrs?.resultPreview).toContain('"results"')

    const schemaEvent = trace.events.find(
      (event) =>
        event.name === 'tool.schema_requested' &&
        event.attrs?.toolName === 'skill_search' &&
        event.attrs?.found === true,
    )
    expect(schemaEvent?.attrs).toMatchObject({
      args: { redacted: true, kind: 'object', keys: 2 },
      result: { redacted: true, kind: 'object', keys: 5 },
    })
    expect(schemaEvent?.attrs?.argsPreview).toContain('需要搜索')
    expect(schemaEvent?.attrs?.resultPreview).toContain('skill_search')
    expect(trace.events.some((event) => event.name === 'checkpoint.commit')).toBe(true)
    expect(JSON.stringify(toolSpan?.attrs?.args)).not.toContain('chart')
  })

  it('ask_user_question：暂停 run（waiting_user + pendingQuestion），循环停止', async () => {
    seedSession('t3', { vendor: 'deepseek', model: 'x' })
    const payload = { id: 'ask1', questions: [{ id: 'q', text: '?', type: 'text' }] }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'ask_user_question', args: payload }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('t3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('t3').store.getter(runAtom)
    expect(run?.status).toBe('waiting_user')
    expect(run?.pendingQuestion).toEqual(payload)
    // 循环停止：只发起一次 model 请求（没有续跑到第二个响应）。
    expect(count()).toBe(1)
    // assistant(tool_calls) 已 append；ask_user 的 ToolItem 未回填（留给 resume）。
    const items = getSessionStore('t3').store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    // 暂停不算收尾：不 commit checkpoint。
    expect(getSessionStore('t3').store.getter(checkpointsAtom)).toHaveLength(0)
  })

  it('ask_user 与其它 tool_call 并列：先补齐其它工具的 result 再暂停（codex P2 回归）', async () => {
    seedSession('t3b', { vendor: 'deepseek', model: 'x' })
    const askPayload = { questions: [{ id: 'q', text: '?', type: 'text' }] }
    const { fetchImpl, count } = seqFetch([
      () =>
        toolCallsResponse([
          { name: 'request_tool_schema', args: { toolName: 'skill_search' }, id: 'ts1' },
          { name: 'ask_user_question', args: askPayload, id: 'ask1' },
        ]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('t3b', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t3b').store
    // 暂停在 waiting_user，只发一次请求（没续跑到第二个响应）。
    expect(store.getter(runAtom)?.status).toBe('waiting_user')
    expect(count()).toBe(1)

    const items = store.getter(itemsAtom)
    // user → assistant(tool_calls) → tool(request_tool_schema 的 result)。ask_user 的 result 留给 resume。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    // 补齐的是 request_tool_schema（ts1），而非 ask_user —— 否则 resume 重发缺 ts1 的 result 会被接口拒绝。
    expect(toolItem.tool_call_id).toBe('ts1')
    // ask_user（ask1）的 result 未回填（留给 resumeWithAnswers）。
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'ask1')).toBe(false)
  })

  it('工具 progress 后抛错 → 进度条目被 finally 清掉（不残留卡住的进度行，codex P2）', async () => {
    toolRegistry.register({
      name: '__throw_after_progress__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute(_args, ctx) {
        ctx.progress('working') // 先写进度
        const err = new DOMException('aborted', 'AbortError')
        throw err // 再抛错
      },
    })
    seedSession('tp', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: '__throw_after_progress__', args: {}, id: 'p1' }]),
    ])

    await runSession('tp', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 无论最终 stopped/error，进度条目都必须被清（finally）。
    expect(getSessionStore('tp').store.getter(toolActivityAtom)).toEqual([])
  })

  it('MAX_AGENT_TURNS：模型不停请求 schema → 到上限后 error', async () => {
    seedSession('t4', { vendor: 'deepseek', model: 'x' })
    let count = 0
    const fetchImpl: typeof fetch = async () => {
      count += 1
      return toolCallsResponse([
        { name: 'request_tool_schema', args: { toolName: 'skill_search', reason: `loop-${count}` } },
      ])
    }

    await runSession('t4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('t4').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('超过最大工具轮数')
    // 恰好跑满上限轮数（MAX_AGENT_TURNS=12）。
    expect(count).toBe(12)
  })

  it('重复 tool-only 调用：第 3 次相同工具签名提前 loop_detected', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('loop1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: 'loop' } }]),
    ])

    await runSession('loop1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const store = getSessionStore('loop1').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('检测到重复工具调用循环')
    expect(count()).toBe(3)
    expect(store.getter(itemsAtom).map((it) => it.item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(
      trace.events.some(
        (event) =>
          event.name === 'agent.loop_detected' &&
          event.attrs?.toolName === 'request_tool_schema' &&
          event.attrs?.repeated_count === 3 &&
          event.attrs?.threshold === 3,
      ),
    ).toBe(true)
    expect(
      trace.spans.some(
        (span) => span.name === 'agent.turn' && span.status === 'error' && span.attrs?.loop_detected === true,
      ),
    ).toBe(true)
  })

  it('多轮里 esc：中途 abort（signal 已断）→ 下一轮写回前守卫成 stopped', async () => {
    seedSession('t5', { vendor: 'deepseek', model: 'x' })
    const controller = new AbortController()
    // 第 1 轮返回 tool_calls（正常处理）；第 2 轮返回前触发 esc。
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: 'x' } }]),
      () => {
        controller.abort()
        return jsonResponse('迟到的答案')
      },
    ])

    await runSession('t5', 'hi', { signal: controller.signal, apiKey: 'k', fetchImpl })

    expect(getSessionStore('t5').store.getter(runAtom)?.status).toBe('stopped')
    const items = getSessionStore('t5').store.getter(itemsAtom)
    // 迟到的最终 assistant 未写回。
    expect(items.some((it) => it.item.role === 'assistant' && 'content' in it.item && it.item.content === '迟到的答案')).toBe(false)
    expect(getSessionStore('t5').store.getter(checkpointsAtom)).toHaveLength(0)
  })
})

describe('危险工具确认门（S4-B）', () => {
  it('危险 shell 参数缺 command：先 validation_failed 回填 tool error，不进入 waiting_confirmation', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('d-shell-invalid', { vendor: 'deepseek', model: 'x' })
    const expectedError = 'invalid shell_macos: command (non-empty string) is required'
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'shell_macos', args: {}, id: 'sh1' }]),
      () => jsonResponse('已处理工具参数错误'),
    ])

    await runSession('d-shell-invalid', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const store = getSessionStore('d-shell-invalid').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('done')
    expect(run?.pendingToolConfirmation).toBeUndefined()
    expect(count()).toBe(2)

    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('sh1')
    expect(toolItem.content).toBe(JSON.stringify({ error: expectedError }))
    expect(
      trace.events.some(
        (event) =>
          event.name === 'tool.validation_failed' &&
          event.attrs?.toolName === 'shell_macos' &&
          event.attrs?.callId === 'sh1' &&
          event.attrs?.validation_failed === true &&
          event.attrs?.validationError === expectedError,
      ),
    ).toBe(true)
    expect(
      trace.spans.some(
        (span) =>
          span.name === 'tool.call' &&
          span.status === 'error' &&
          span.attrs?.toolName === 'shell_macos' &&
          span.attrs?.callId === 'sh1' &&
          span.attrs?.validation_failed === true &&
          span.attrs?.validationError === expectedError,
      ),
    ).toBe(true)
    expect(trace.events.some((event) => event.name === 'agent.waiting_confirmation')).toBe(false)
  })

  it('危险工具（write_file）：暂停 waiting_confirmation + pendingToolConfirmation，循环停止、不执行、不回填', async () => {
    seedSession('d1', { vendor: 'deepseek', model: 'x' })
    const args = { path: 'a.txt', content: 'hi' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'write_file', args, id: 'w1' }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d1').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('waiting_confirmation')
    expect(run?.pendingToolConfirmation).toEqual({ callId: 'w1', toolName: 'write_file', args })
    // 循环停止：只发起一次 model 请求（没续跑到第二个响应）。
    expect(count()).toBe(1)
    // assistant(tool_calls) 已 append；危险工具的 ToolItem 未回填（留给 confirmTool）。
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    expect(items.some((it) => it.item.role === 'tool')).toBe(false)
    // 暂停不算收尾：不 commit checkpoint。
    expect(store.getter(checkpointsAtom)).toHaveLength(0)
  })

  it('只读 server 工具（read_file）：不触发确认，正常执行并续跑到 done', async () => {
    seedSession('d2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'read_file', args: { path: 'a.txt' }, id: 'r1' }]),
      () => jsonResponse('读完了'),
    ])

    await runSession('d2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d2').store
    // 没有停在 waiting_confirmation，一路跑到 done。
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(2)
    // read_file 已执行并回填了 ToolItem（tool_call_id=r1）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'r1')).toBe(true)
  })

  it('「本 session 一律允许」命中：危险工具不再确认，直接执行续跑', async () => {
    seedSession('d3', { vendor: 'deepseek', model: 'x' })
    // 预置：本 session 已一律允许 write_file。
    getSessionStore('d3').store.setter(alwaysAllowedToolsAtom, ['write_file'])
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{ name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' }]),
      () => jsonResponse('写完了'),
    ])

    await runSession('d3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d3').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(2)
    // write_file 已执行并回填了 ToolItem（未暂停确认）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(true)
  })

  it('危险工具与其它 tool_call 并列：先补齐其它工具 result 再暂停确认（不 orphan）', async () => {
    seedSession('d4', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () =>
        toolCallsResponse([
          { name: 'request_tool_schema', args: { toolName: 'skill_search' }, id: 'ts1' },
          { name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' },
        ]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d4').store
    expect(store.getter(runAtom)?.status).toBe('waiting_confirmation')
    expect(count()).toBe(1)
    const items = store.getter(itemsAtom)
    // user → assistant(tool_calls) → tool(request_tool_schema 的 result)。write_file 的 result 留给确认恢复。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('ts1')
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(false)
  })

  it('resumeToolCall：确认恢复入口先执行被确认工具、回填 result，再续跑到 done', async () => {
    seedSession('d5', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('d5').store
    // 预置暂停前状态：user + assistant(tool_calls:[write_file w1])（w1 result 特意留空）+ pending run。
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
        },
      },
    ])
    setRun('d5', { runId: 'R1', status: 'running' })
    const fetchImpl: typeof fetch = async () => jsonResponse('最终答案')

    await runToolLoop('d5', 'R1', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      resumeToolCall: { callId: 'w1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    })

    const items = store.getter(itemsAtom)
    // user → assistant(tool_calls) → tool(w1 的 result，恢复入口执行后回填) → assistant(final)。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('w1')
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })
})

describe('runToolLoop（resume 复用的循环入口，T-7）', () => {
  it('直接跑 runToolLoop：seed items + setRun 后跑到 done，不 append user', async () => {
    seedSession('r1', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('r1').store
    // 预置一条 user（模拟暂停前已在库）+ 一个 pending run —— runToolLoop 不再 append user。
    store.setter(itemsAtom, [{ id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } }])
    setRun('r1', { runId: 'R1', status: 'running' })
    const fetchImpl: typeof fetch = async () => jsonResponse('答案')

    await runToolLoop('r1', 'R1', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = store.getter(itemsAtom)
    // 只 append 了最终 assistant，没有新增 user（复用已有 user）。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    expect(items[1].item).toEqual({ role: 'assistant', content: '答案' })
    expect(store.getter(runAtom)?.status).toBe('done')
    // 一轮收尾 = 一个 checkpoint。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })
})
