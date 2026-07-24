// P-R2 最小单轮 run 的单测（红→绿）。
// ---------------------------------------------------------------------------
// 契约 U5：只 input→model→reply（不做 lazy tools/多 agent/pipeline）。
// 契约 U7：signal 全穿透 + 失败降级（AbortError→stopped；其它→error），绝不抛崩。
// 只依赖状态层 + api 层；mock fetchImpl 注入模型响应/异常。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom, planAtom } from '../state/sessionAtoms'
import { executionGraphAtom } from '../execution/graph'
import { getExecutionRuntime } from '../execution/runtime'
import { patchRun, setRun } from '../state/sessionWriters'
import {
  toolActivityAtom,
  alwaysAllowedToolsAtom,
  runtimeTranscriptEventsAtom,
  contextStatsAtom,
  queuedUserMessagesAtom,
  enqueueUserMessage,
} from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import type { ModelSettings } from '../state/core.type'
import type { ModelFunctionTool, ModelUsage } from '@web-agent/ai'
import { resumePlanSession, runSession, runToolLoop } from './modelRun'
import { configurePersistence, resetPersistence } from './persistenceBridge'
import type { Checkpoint } from '../state/checkpoint.type'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import { createCoreInstance } from './core/coreInstance'
import { createCore } from './core/createCore'

// delegateRuntime.dispose 的失败注入闸门。★ 只在 disposeControl.error 被显式设过时才把 dispose
// 换成抛错版本 ★ —— 其余用例拿到的仍是货真价实的 delegate runtime，本文件其它测试完全不受影响。
const disposeControl = vi.hoisted(() => ({ error: undefined as Error | undefined }))
const tauriControl = vi.hoisted(() => ({ enabled: false }))
vi.mock('@tauri-apps/api/core', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/api/core')>('@tauri-apps/api/core')
  return {
    ...actual,
    isTauri: () => tauriControl.enabled,
  }
})
vi.mock('../subagents/runtime', async () => {
  const actual = await vi.importActual<typeof import('../subagents/runtime')>('../subagents/runtime')
  return {
    ...actual,
    createDelegateAgentRuntime: (opts: Parameters<typeof actual.createDelegateAgentRuntime>[0]) => {
      const runtime = actual.createDelegateAgentRuntime(opts)
      const failure = disposeControl.error
      if (!failure) return runtime
      return {
        ...runtime,
        dispose: async () => {
          throw failure
        },
      }
    },
  }
})

afterEach(() => {
  disposeControl.error = undefined
  tauriControl.enabled = false
  resetObservability()
  resetPersistence()
  resetRootStore()
  resetSessionStores()
})

// 只记录 saveCheckpoint 的假 HistoryDriver —— 用来证明「落盘」真的发生了，
// 而不只是 checkpointsAtom 里多了一条（itemsAtom 不持久化，刷新后全靠落盘的 checkpoint）。
function captureCheckpointPersistence(): { saved: Array<{ sessionId: string; checkpoint: Checkpoint }> } {
  const saved: Array<{ sessionId: string; checkpoint: Checkpoint }> = []
  configurePersistence({
    history: {
      async listCheckpoints() {
        return []
      },
      async loadCheckpoint() {
        return undefined
      },
      async saveCheckpoint(sessionId, checkpoint) {
        saved.push({ sessionId, checkpoint })
      },
      async truncateAfter() {},
      async deleteSession() {},
    },
  })
  return { saved }
}

// 在 rootStore 登记一个会话（ghost guard 的权威事实）。
function seedSession(id: string, settings: ModelSettings): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings, createdAt: Date.now(), updatedAt: Date.now() },
  }))
}

// 非流式响应：postChatCompletion 走 res.json()。
function jsonResponse(
  content: string,
  usage?: ModelUsage,
): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage }),
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

// 指定 finish_reason 的普通（无 tool_calls）响应 —— 用于 length/content_filter/容量不足三态。
function finishReasonResponse(finishReason: string, content: string | null): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// tool_calls 响应，但 arguments 由调用方给「原始字符串」—— 用于构造被截断/非法的参数 JSON。
function rawToolCallsResponse(
  finishReason: string,
  calls: Array<{ name: string; args: string; id: string }>,
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args },
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
  it('passes only the current CoreInstance DeepSeek user id into the request body', async () => {
    const core = createCoreInstance({
      config: { deepseekUserId: 'wa_isolated_core_0123' },
    })
    const id = 'instance-deepseek-user-id'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let body: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse('ok')
    }

    await runSession(id, 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    expect(body?.user_id).toBe('wa_isolated_core_0123')
  })

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

  it('模型请求期间追加输入：当前回复落库后按 FIFO 注入同一 run 的下一轮', async () => {
    seedSession('queued-final', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('queued-final').store
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = []
    let requestCount = 0
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      requestCount += 1
      return requestCount === 1 ? firstResponse : jsonResponse('收到补充')
    }

    const running = runSession('queued-final', '先做第一件事', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await waitUntil(() => requestCount === 1, 'first queued request')
    const runId = store.getter(runAtom)?.runId
    expect(runId).toBeTruthy()
    const queuedAt = Date.now()
    enqueueUserMessage('queued-final', {
      id: 'queued-user-1',
      createdAt: queuedAt,
      content: '再补充第二件事',
      targetRunId: runId!,
    })

    resolveFirst(jsonResponse('第一件事完成'))
    await running

    expect(requestCount).toBe(2)
    expect(store.getter(runAtom)).toMatchObject({ runId, status: 'done' })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(store.getter(itemsAtom)[2]).toMatchObject({
      id: 'queued-user-1',
      createdAt: queuedAt,
      item: { role: 'user', content: '再补充第二件事' },
    })
    expect(bodies[1].messages.filter(({ role }) => role !== 'system').map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('工具调用期间追加输入：等待完整 tool result 后再注入，协议顺序不被打断', async () => {
    seedSession('queued-tool', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('queued-tool').store
    const bodies: Array<{ messages: Array<{ role: string }> }> = []
    let requestCount = 0
    let resolveFirst!: (response: Response) => void
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      requestCount += 1
      return requestCount === 1 ? firstResponse : jsonResponse('工具和补充都处理完了')
    }

    const running = runSession('queued-tool', '先查工具', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await waitUntil(() => requestCount === 1, 'first tool request')
    const runId = store.getter(runAtom)?.runId
    enqueueUserMessage('queued-tool', {
      id: 'queued-user-tool',
      createdAt: Date.now(),
      content: '工具完成后再考虑这个补充',
      targetRunId: runId!,
    })

    resolveFirst(toolCallsResponse([
      {
        id: 'tool-call-1',
        name: 'request_tool_schema',
        args: { toolName: 'skill_search', reason: '查看工具' },
      },
    ]))
    await running

    expect(requestCount).toBe(2)
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ])
    expect(bodies[1].messages.filter(({ role }) => role !== 'system').map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
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
    expect(getSessionStore('s2').store.getter(contextStatsAtom)?.cache?.metricsStatus).toBe('cancelled')
    expect(getSessionStore('s2').store.getter(contextStatsAtom)?.usage).toBeUndefined()
  })

  it('abort：fetch polyfill 抛「普通 Error + name=AbortError」（Tauri/node-fetch 形态）→ 同样 stopped', async () => {
    seedSession('s2b', { vendor: 'deepseek', model: 'x' })
    // ★ 回归：不是每个 fetch 实现都抛 DOMException。Tauri / node-fetch 等 polyfill 只给一个
    //   name==='AbortError' 的普通 Error；modelApi 按鸭子类型识别并如实透传，modelRun 的最外层
    //   catch 若还写 `err instanceof DOMException` 就认不出来 —— 用户按了停止键，run 却落成
    //   'error' 加一段英文异常。
    const fetchImpl: typeof fetch = async () => {
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    }

    await expect(
      runSession('s2b', 'hi', {
        signal: new AbortController().signal,
        apiKey: 'k',
        fetchImpl,
      }),
    ).resolves.toBeUndefined()

    const run = getSessionStore('s2b').store.getter(runAtom)
    expect(run?.status).toBe('stopped')
    // 不该被当成通用失败：不留英文异常文案。
    expect(run?.error).toBeUndefined()
    expect(getSessionStore('s2b').store.getter(itemsAtom)).toHaveLength(1)
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
    expect(getSessionStore('s3').store.getter(contextStatsAtom)?.cache?.metricsStatus).toBe('request_failed')
    expect(getSessionStore('s3').store.getter(contextStatsAtom)?.usage).toBeUndefined()
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

  it('DeepSeek thinking 请求保留会话设置，但只转发兼容的 thinking/reasoning_effort', async () => {
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
    expect(captured).not.toHaveProperty('temperature')
    expect(captured.thinking).toEqual({ type: 'enabled' })
    expect(captured.reasoning_effort).toBe('high')
    expect(rootStore.getter(sessionsAtom).s5.settings.temperature).toBe(0.5)
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
    expect(messages[0].content).not.toContain('已匹配、但正文尚未读取的 skills：')
    expect(messages[0].content).toContain('禁止凭工具名猜参数')
    expect(messages.slice(1).map((item) => item.role)).toEqual(['user', 'system'])
    expect(messages[2].content).toContain('已匹配、但正文尚未读取的 skills：')

    const events = store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.kind === 'system_injection' && event.detail?.includes('已匹配、但正文尚未读取的 skills：'))).toBe(
      true,
    )
    expect(events.some((event) => event.kind === 'tool_manifest' && event.detail?.includes('request_tool_schema'))).toBe(
      true,
    )
  })

  it('context stats：记录最近一次真实发送的 messages/tools，并在响应后补 provider usage', async () => {
    seedSession('ctx1', { vendor: 'deepseek', model: 'm' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok', {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_cache_hit_tokens: 8,
        prompt_cache_miss_tokens: 4,
      }))
    }

    await runSession('ctx1', '统计一下 context', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const stats = getSessionStore('ctx1').store.getter(contextStatsAtom)
    expect(stats).toBeDefined()
    expect(stats).toMatchObject({
      vendor: 'deepseek',
      model: 'm',
      llmTurn: 1,
      messagesCount: (captured.messages as unknown[]).length,
      toolsCount: (captured.tools as unknown[]).length,
      usage: {
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
        cacheHitTokens: 8,
        cacheMissTokens: 4,
        cacheMissSource: 'provider',
        cacheHitRate: 2 / 3,
      },
      cache: {
        lane: 'main',
        epoch: 1,
        epochReason: 'initial',
        metricsStatus: 'available',
      },
      cacheTotals: {
        measuredRequests: 1,
        hitTokens: 8,
        missTokens: 4,
        hitRate: 2 / 3,
      },
      finishReason: null,
    })
    expect(stats?.roles.system.count).toBe(2)
    expect(stats?.roles.user.count).toBe(1)
    expect(stats?.roles.assistant.count).toBe(0)
    expect(stats?.toolNames).toContain('request_tool_schema')
    expect(stats?.estimatedTokens).toBeGreaterThan(0)
    expect(stats?.totalChars).toBe((stats?.messagesChars ?? 0) + (stats?.toolsChars ?? 0))
  })

  it('context cache trace：成功与失败都留下明确指标状态，失败不伪造 token', async () => {
    const successTrace = captureTrace()
    configureObservability({ driver: successTrace.driver })
    seedSession('ctx-trace-ok', { vendor: 'deepseek', model: 'm' })

    await runSession('ctx-trace-ok', 'cache trace', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse('ok', {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 6,
        prompt_cache_miss_tokens: 4,
      }),
    })
    await flushObservability()

    const successfulLlm = successTrace.spans.find(
      (span) => span.name === 'llm.chat' && span.status === 'ok',
    )
    expect(successfulLlm?.attrs).toMatchObject({
      cache_metrics_status: 'available',
      cache_hit_tk: 6,
      cache_miss_tk: 4,
      cache_miss_source: 'provider',
    })

    resetObservability()
    const failedTrace = captureTrace()
    configureObservability({ driver: failedTrace.driver })
    seedSession('ctx-trace-fail', { vendor: 'deepseek', model: 'm' })

    await runSession('ctx-trace-fail', 'cache trace fail', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('provider unavailable')
      },
    })
    await flushObservability()

    const failedLlm = failedTrace.spans.find(
      (span) => span.name === 'llm.chat' && span.status === 'error',
    )
    expect(failedLlm?.status).toBe('error')
    expect(failedLlm?.attrs?.cache_metrics_status).toBe('request_failed')
    expect(failedLlm?.attrs).not.toHaveProperty('cache_hit_tk')
    expect(failedLlm?.attrs).not.toHaveProperty('cache_miss_tk')
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

  it('流式 reasoning：正文开始前就写 pending assistant，结束后保留完整思考', async () => {
    seedSession('stream-reasoning', { vendor: 'deepseek', model: 'x' })
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

    const runPromise = runSession('stream-reasoning', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    await waitUntil(() => controller !== undefined, 'stream controller')
    controller!.enqueue(encoder.encode(sseBlock({
      choices: [{ delta: { content: null, reasoning_content: '先分析' } }],
    })))

    await waitUntil(
      () => getSessionStore('stream-reasoning').store.getter(itemsAtom).some((it) => it.item.role === 'assistant'),
      'streamed reasoning item',
    )
    const during = getSessionStore('stream-reasoning').store.getter(itemsAtom)
    const assistantId = during.find((it) => it.item.role === 'assistant')?.id
    expect(during[1]).toMatchObject({
      id: assistantId,
      pending: true,
      item: { role: 'assistant', content: '', reasoning_content: '先分析' },
    })

    controller!.enqueue(encoder.encode(sseBlock({
      choices: [{ delta: { content: '答案', reasoning_content: null }, finish_reason: 'stop' }],
    })))
    controller!.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller!.close()
    await runPromise

    const done = getSessionStore('stream-reasoning').store.getter(itemsAtom)
    expect(done).toHaveLength(2)
    expect(done[1]).toMatchObject({
      id: assistantId,
      pending: false,
      item: { role: 'assistant', content: '答案', reasoning_content: '先分析' },
    })
    expect(getSessionStore('stream-reasoning').store.getter(runAtom)?.status).toBe('done')
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
    // 历史只保留加载确认与 guide；inputSchema 仅在下一轮请求的顶层 tools 中出现。
    const schemaResult = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(schemaResult).toMatchObject({
      loaded: true,
      toolName: 'skill_search',
    })
    expect(typeof schemaResult.guide).toBe('string')
    expect(schemaResult).not.toHaveProperty('inputSchema')

    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
    expect((items[3].item as { content?: string }).content).toBe('最终答案')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('新 run 从历史恢复已加载 schema：首个请求放顶层 tools，并保留 loader 历史', async () => {
    seedSession('schema-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('schema-resume').store
    store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user', content: '继续执行' } },
      {
        id: 'schema-call',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'load-search',
            type: 'function',
            function: {
              name: 'request_tool_schema',
              arguments: '{"toolName":"skill_search","reason":"需要搜索"}',
            },
          }],
        },
      },
      {
        id: 'schema-result',
        createdAt: 3,
        item: {
          role: 'tool',
          tool_call_id: 'load-search',
          content: '{"loaded":true,"toolName":"skill_search","guide":"旧 guide"}',
        },
      },
    ])
    setRun('schema-resume', { runId: 'resumed-run', status: 'running' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(init!.body as string) as Record<string, unknown>
      return jsonResponse('已继续')
    }

    await runToolLoop('schema-resume', 'resumed-run', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const sentTools = captured.tools as ModelFunctionTool[]
    expect(sentTools.map((tool) => tool.function.name)).toContain('skill_search')
    const searchTool = sentTools.find((tool) => tool.function.name === 'skill_search')
    const currentSearchTool = toolRegistry.loadSchema('skill_search')
    expect(searchTool?.function.parameters).toEqual(currentSearchTool?.inputSchema)
    expect(searchTool?.function.description).toContain(currentSearchTool?.guide)
    expect(searchTool?.function.description).not.toContain('旧 guide')

    const sentMessages = captured.messages as Array<Record<string, unknown>>
    expect(sentMessages.some((message) =>
      message.role === 'assistant'
      && JSON.stringify(message).includes('request_tool_schema')
    )).toBe(true)
    expect(sentMessages.some((message) =>
      message.role === 'tool'
      && message.tool_call_id === 'load-search'
    )).toBe(true)
    expect(JSON.stringify(sentMessages)).toContain('旧 guide')
    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
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

  it('未加载工具被幻觉调用时不执行，并引导先加载 schema 后恢复', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('lazy-guard', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      // 第一轮只向模型暴露 request_tool_schema；模拟 provider 仍凭名称猜调用和参数。
      () => toolCallsResponse([{ name: 'skill_search', args: { skillName: 'planning' }, id: 'guessed' }]),
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'skill_search', reason: '读取正确参数' },
        id: 'load',
      }]),
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'planning' }, id: 'search' }]),
      () => jsonResponse('已恢复'),
    ])

    await runSession('lazy-guard', '规划任务', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const items = getSessionStore('lazy-guard').store.getter(itemsAtom)
    const guessedResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'guessed',
    )?.item
    if (!guessedResult || guessedResult.role !== 'tool') throw new Error('缺少未加载工具结果')
    expect(guessedResult.content).toContain('tool_schema_not_loaded')
    expect(guessedResult.content).toContain('request_tool_schema')
    expect(guessedResult.content).not.toContain('缺少必填字段')

    const searchResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'search',
    )?.item
    if (!searchResult || searchResult.role !== 'tool') throw new Error('缺少搜索结果')
    expect(searchResult.content).toContain('results')
    expect(trace.events.some((event) =>
      event.name === 'tool.schema_not_loaded' && event.attrs?.toolName === 'skill_search'
    )).toBe(true)
    expect(getSessionStore('lazy-guard').store.getter(runAtom)?.status).toBe('done')
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
      result: { redacted: true, kind: 'object', keys: 3 },
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
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'ask_user_question', reason: '需要询问用户' },
      }]),
      () => toolCallsResponse([{ name: 'ask_user_question', args: payload }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('t3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('t3').store.getter(runAtom)
    expect(run?.status).toBe('waiting_user')
    expect(run?.pendingQuestion).toEqual(payload)
    expect(run?.pendingUserDecision).toMatchObject({
      callId: expect.any(String),
      payload,
      origin: { surface: 'conversation' },
    })
    // schema 加载后暂停，没有续跑到最终文本。
    expect(count()).toBe(2)
    // schema call 已完整回填；ask_user 的 ToolItem 未回填（留给 resume）。
    const items = getSessionStore('t3').store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // 暂停不算收尾：不 commit checkpoint。
    expect(getSessionStore('t3').store.getter(checkpointsAtom)).toHaveLength(0)
  })

  it('已有 ask_user 答案后，新的 ask call 仍可再次中断同一个 run', async () => {
    seedSession('ask-twice', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('ask-twice').store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '规划并执行' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'ask-first',
            type: 'function',
            function: { name: 'ask_user_question', arguments: '{"questions":[]}' },
          }],
        },
      },
      {
        id: 'answer-first',
        createdAt: 3,
        item: { role: 'tool', tool_call_id: 'ask-first', content: '{"answers":{"q1":"A"}}' },
      },
    ])
    setRun('ask-twice', { runId: 'R-twice', status: 'running' })
    const secondPayload = {
      context: { surface: 'plan', phase: 'drafting' },
      questions: [{ id: 'q2', text: '第二个决策？', type: 'text' }],
    }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'ask_user_question', reason: '需要再次询问用户' },
      }]),
      () => toolCallsResponse([{ name: 'ask_user_question', args: secondPayload, id: 'ask-second' }]),
      () => jsonResponse('不该继续'),
    ])

    await runToolLoop('ask-twice', 'R-twice', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(count()).toBe(2)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'waiting_user',
      pendingUserDecision: {
        callId: 'ask-second',
        payload: secondPayload,
        origin: { surface: 'plan', phase: 'drafting' },
      },
    })
  })

  it('create_plan required：进入专用计划审批状态，模型不能自行继续', async () => {
    seedSession('plan-wait', { vendor: 'deepseek', model: 'x' })
    const args = {
      title: '实现功能', objective: '完成实现与验证', approvalMode: 'required',
      stages: [{ id: 'build', title: '实现', objective: '写代码', acceptanceCriteria: ['测试通过'] }],
    }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'create_plan', reason: '需要创建计划' },
      }]),
      () => toolCallsResponse([{ name: 'create_plan', args, id: 'plan-call' }]),
      () => jsonResponse('不应在批准前继续'),
    ])

    await runSession('plan-wait', '把这个复杂功能做好，先给我确认计划', {
      signal: new AbortController().signal, apiKey: 'k', fetchImpl,
    })

    const store = getSessionStore('plan-wait').store
    const plan = store.getter(planAtom)
    expect(plan?.status).toBe('awaiting_approval')
    expect(store.getter(runAtom)).toMatchObject({
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'plan-call', planId: plan?.id, revision: 1 },
    })
    expect(count()).toBe(2)
    expect(store.getter(itemsAtom).map((item) => item.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
    ])
  })

  it('ask_user 与其它 tool_call 并列：先补齐其它工具的 result 再暂停（codex P2 回归）', async () => {
    seedSession('t3b', { vendor: 'deepseek', model: 'x' })
    const askPayload = { id: 'ask-payload', questions: [{ id: 'q', text: '?', type: 'text' }] }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'ask_user_question', reason: '需要询问用户' },
      }]),
      () =>
        toolCallsResponse([
          { name: 'request_tool_schema', args: { toolName: 'skill_search' }, id: 'ts1' },
          { name: 'ask_user_question', args: askPayload, id: 'ask1' },
        ]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('t3b', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t3b').store
    // 加载 ask schema 后暂停，没续跑到最终文本。
    expect(store.getter(runAtom)?.status).toBe('waiting_user')
    expect(count()).toBe(2)

    const items = store.getter(itemsAtom)
    // 两次 request_tool_schema 均回填；ask_user 的 result 留给 resume。
    expect(items.map((it) => it.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool',
    ])
    const toolItem = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'ts1',
    )?.item
    if (!toolItem || toolItem.role !== 'tool') throw new Error('意外的条目形状')
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

  it('同一模型轮次的显式只读工具作为执行图兄弟节点并发运行', async () => {
    let firstStarted = false
    let secondStarted = false
    let releaseFirst = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    toolRegistry.register({
      name: '__parallel_read_a__',
      runtime: 'internal',
      execution: { mode: 'parallel', effectKeys: ['test:read'] },
      skill: { description: 'x', content: 'x' },
      inputSchema: { type: 'object' },
      async execute() {
        firstStarted = true
        await firstGate
        return { ok: true, data: 'a' }
      },
    })
    toolRegistry.register({
      name: '__parallel_read_b__',
      runtime: 'internal',
      execution: { mode: 'parallel', effectKeys: ['test:read'] },
      skill: { description: 'x', content: 'x' },
      inputSchema: { type: 'object' },
      execute() {
        secondStarted = true
        return { ok: true, data: 'b' }
      },
    })
    seedSession('parallel-tools', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: '__parallel_read_a__', reason: '加载只读工具 A' },
        id: 'load-read-a',
      }]),
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: '__parallel_read_b__', reason: '加载只读工具 B' },
        id: 'load-read-b',
      }]),
      () => toolCallsResponse([
        { name: '__parallel_read_a__', args: {}, id: 'read-a' },
        { name: '__parallel_read_b__', args: {}, id: 'read-b' },
      ]),
      () => jsonResponse('done'),
    ])

    const running = runSession('parallel-tools', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    try {
      await waitUntil(() => firstStarted && secondStarted, 'parallel tools to start')
    } finally {
      releaseFirst()
    }
    await running

    const store = getSessionStore('parallel-tools').store
    const graph = store.getter(executionGraphAtom)
    expect(graph.nodes['read-a']).toMatchObject({
      type: 'tool',
      status: 'succeeded',
      effectKeys: ['test:read'],
    })
    expect(graph.nodes['read-b']).toMatchObject({ type: 'tool', status: 'succeeded' })
    expect(store.getter(itemsAtom).flatMap(({ item }) =>
      item.role === 'tool' ? [item.tool_call_id] : [],
    ).filter((callId) => callId === 'read-a' || callId === 'read-b')).toEqual(['read-a', 'read-b'])
  })

  it('普通运行：模型不停请求 schema → 32 轮后 error，但整轮仍落 checkpoint', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('t4', { vendor: 'deepseek', model: 'x' })
    let count = 0
    const fetchImpl: typeof fetch = async () => {
      count += 1
      return toolCallsResponse([
        { name: 'request_tool_schema', args: { toolName: 'skill_search', reason: `loop-${count}` } },
      ])
    }

    await runSession('t4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t4').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('主 Agent 超过最大模型轮次（32）')
    // 恰好跑满主 Agent 上限；子 Agent 使用独立循环与预算，不计入这里。
    expect(count).toBe(32)
    // ★ 回归：跑满 32 轮时 itemsAtom 里已堆了大量 assistant/tool 条目，整轮不落盘代价最大 ——
    //   刷新后连用户那条 user 消息都没了。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(persistence.saved).toHaveLength(1)
    expect(persistence.saved[0].checkpoint.items[0].item).toEqual({ role: 'user', content: 'hi' })
  })

  it('计划运行：按阶段数放大主 Agent 轮次预算，且不计入子 Agent 轮次', async () => {
    seedSession('plan-turn-limit', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-turn-limit').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-1',
      title: '单阶段计划',
      objective: '验证计划轮次预算',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-1',
        title: '执行',
        objective: '持续执行',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    let count = 0
    const fetchImpl: typeof fetch = async () => {
      count += 1
      return toolCallsResponse([
        { name: 'request_tool_schema', args: { toolName: 'skill_search', reason: `plan-loop-${count}` } },
      ])
    }

    await runSession('plan-turn-limit', '执行计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(count).toBe(64)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'error',
      error: '主 Agent 超过最大模型轮次（64）',
    })
  })

  it('计划恢复：沿原用户轮次直接续跑，不追加新的 user item', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('plan-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-resume').store
    const now = Date.now()
    const savedItems = [
      { id: 'original-user', createdAt: 1, item: { role: 'user', content: '完成这个多步骤任务' } },
      { id: 'saved-progress', createdAt: 2, item: { role: 'assistant', content: '已完成部分工作。' } },
    ] as const
    store.setter(itemsAtom, [...savedItems])
    store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: '[执行中] 完成这个多步骤任务',
      createdAt: 2,
      items: [...savedItems],
    }])
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-resume-1',
      title: '恢复计划',
      objective: '完成剩余工作',
      status: 'active',
      revision: 3,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-current',
        title: '当前阶段',
        objective: '继续实现',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> }
      expect(body.messages.filter((message) => message.role === 'user')).toEqual([
        { role: 'user', content: '完成这个多步骤任务' },
      ])
      expect(body.messages.some((message) => message.content?.includes('<current_plan_snapshot>'))).toBe(true)
      expect(body.messages.at(-1)).toMatchObject({
        role: 'system',
        content: expect.stringContaining('从持久化状态恢复'),
      })
      store.setter(planAtom, (plan) => plan ? {
        ...plan,
        status: 'completed',
        stages: plan.stages.map((stage) => ({ ...stage, status: 'completed' as const })),
      } : plan)
      return jsonResponse('剩余工作已完成。')
    }

    await resumePlanSession('plan-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(store.getter(itemsAtom).filter((item) => item.item.role === 'user')).toHaveLength(1)
    expect(store.getter(itemsAtom).at(-1)?.item).toEqual({ role: 'assistant', content: '剩余工作已完成。' })
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0].label).toBe('完成这个多步骤任务')
    expect(persistence.saved.at(-1)?.checkpoint.turnIndex).toBe(0)
  })

  it('计划恢复：上次 evaluator 基础设施失败时只重试既有提交，不重新执行阶段', async () => {
    seedSession('plan-resume-evaluator-retry', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-resume-evaluator-retry').store
    const now = Date.now()
    store.setter(itemsAtom, [{
      id: 'original-user',
      createdAt: 1,
      item: { role: 'user', content: '完成这个多步骤任务' },
    }])
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-retry-1',
      title: '恢复验收',
      objective: '完成剩余工作',
      status: 'active',
      revision: 7,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-current',
        title: '当前阶段',
        objective: '实现功能',
        deliverables: [],
        acceptanceCriteria: ['测试通过'],
        dependencies: [],
        status: 'in_progress',
        evidence: ['pnpm test 通过'],
        evaluations: [{
          attempt: 1,
          status: 'unknown',
          summary: '功能已经实现',
          submittedEvidence: ['pnpm test 通过'],
          criteria: [{
            criterion: '测试通过',
            status: 'unknown',
            evidence: [],
            reason: 'JSON Parse error: Unexpected EOF',
          }],
          submittedAt: now - 2,
          evaluatedAt: now - 1,
        }],
      }],
    })
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> }
      const injected = body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
      expect(injected).toContain('上次只是 evaluator 基础设施失败')
      expect(injected).toContain('不要重新实现')
      expect(injected).toContain('"revision":7')
      expect(injected).toContain('"summary":"功能已经实现"')
      expect(injected).toContain('JSON Parse error: Unexpected EOF')
      store.setter(planAtom, (plan) => plan ? {
        ...plan,
        status: 'completed',
        stages: plan.stages.map((stage) => ({ ...stage, status: 'completed' as const })),
      } : plan)
      return jsonResponse('验收已通过。')
    }

    await resumePlanSession('plan-resume-evaluator-retry', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('阶段评估在后台运行时暂停父循环，并在 execution atom 完成后自动续跑', async () => {
    const core = createCoreInstance()
    const sessionId = 'plan-background-evaluation'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    const store = core.getSessionStore(sessionId).store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-background',
      title: '后台评估计划',
      objective: '验证父循环等待子节点',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-1',
        title: '第一阶段',
        objective: '完成第一阶段',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })

    let releaseEvaluation = (): void => {}
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve
    })
    core.tools.register({
      name: 'submit_stage_result',
      runtime: 'internal',
      skill: { description: '提交阶段结果', content: '测试后台阶段评估' },
      inputSchema: { type: 'object', properties: {} },
      execute(_args, ctx) {
        store.setter(planAtom, (plan) => plan ? {
          ...plan,
          status: 'evaluating',
          revision: plan.revision + 1,
          stages: plan.stages.map((stage) => ({ ...stage, status: 'evaluating' as const })),
        } : plan)
        const evaluation = getExecutionRuntime(core).spawn({
          sessionId,
          runId: 'evaluation-run',
          label: '评估第一阶段',
          async task() {
            await evaluationGate
            store.setter(planAtom, (plan) => plan ? {
              ...plan,
              status: 'completed',
              revision: plan.revision + 1,
              stages: plan.stages.map((stage) => ({ ...stage, status: 'completed' as const })),
            } : plan)
            return { passed: true }
          },
        })
        return { ok: true, data: { plan: store.getter(planAtom), evaluation } }
      },
    })

    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'submit_stage_result', reason: '提交第一阶段' },
        id: 'load-submit-stage',
      }]),
      () => toolCallsResponse([{
        name: 'submit_stage_result',
        args: {},
        id: 'submit-stage',
      }]),
      () => jsonResponse('计划已完成'),
    ])

    await runSession(sessionId, '执行计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    expect(count()).toBe(2)
    expect(store.getter(runAtom)?.status).toBe('awaiting_tool')
    expect(store.getter(planAtom)?.stages[0].status).toBe('evaluating')

    releaseEvaluation()
    await waitUntil(() => store.getter(runAtom)?.status === 'done', 'plan evaluation continuation')

    expect(count()).toBe(3)
    expect(store.getter(planAtom)?.status).toBe('completed')
    expect(store.getter(itemsAtom).filter(({ item }) =>
      item.role === 'assistant' && item.tool_calls?.some((call) => call.function.name === 'submit_stage_result'),
    )).toHaveLength(1)
  })

  it('计划仍在执行时，文本总结只算阶段说明并继续运行，不能提前结束', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('plan-premature-final', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-premature-final').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-premature',
      title: '多阶段计划',
      objective: '完整完成计划',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-current',
        title: '当前阶段',
        objective: '完成当前工作',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    toolRegistry.register({
      name: '__complete_plan_for_test__',
      runtime: 'internal',
      skill: { description: '完成测试计划', content: '仅用于测试' },
      inputSchema: { type: 'object', properties: {} },
      execute() {
        store.setter(planAtom, (plan) => plan ? {
          ...plan,
          status: 'completed',
          stages: plan.stages.map((stage) => ({ ...stage, status: 'completed' as const })),
        } : plan)
        return { ok: true, data: { completed: true } }
      },
    })
    let count = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      count += 1
      if (count === 1) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> }
        expect(body.messages.at(-1)).toMatchObject({
          role: 'system',
          content: expect.stringContaining('<current_plan_snapshot>'),
        })
        expect(body.messages.at(-1)?.content).toContain('"planId":"plan-premature"')
        expect(body.messages.at(-1)?.content).toContain('"revision":1')
        expect(body.messages.at(-1)?.content).toContain('"stageId":"stage-current"')
        return jsonResponse('总结：整个任务已完成')
      }
      if (count === 2) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> }
        expect(body.messages.at(-1)).toMatchObject({
          role: 'system',
          content: expect.stringContaining('结构化计划尚未完成'),
        })
        return toolCallsResponse([{
          name: 'request_tool_schema',
          args: { toolName: '__complete_plan_for_test__', reason: '继续完成计划' },
          id: 'load-complete-plan',
        }])
      }
      if (count === 3) {
        return toolCallsResponse([{
          name: '__complete_plan_for_test__',
          args: {},
          id: 'complete-plan',
        }])
      }
      return jsonResponse('计划已通过验收并完成')
    }

    await runSession('plan-premature-final', '执行完整计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(count).toBe(4)
    expect(store.getter(runAtom)?.status).toBe('done')
    const assistantItems = store.getter(itemsAtom).filter((item) => item.item.role === 'assistant')
    expect(assistantItems.find((item) => item.item.content === '总结：整个任务已完成')).toMatchObject({
      planStageId: 'stage-current',
      item: { content: '总结：整个任务已完成' },
    })
    expect(assistantItems.find((item) => item.item.content === '计划已通过验收并完成')).toMatchObject({
      planStageId: undefined,
      item: { content: '计划已通过验收并完成' },
    })
    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].label).toBe('执行完整计划')
    expect(persistence.saved.length).toBeGreaterThan(1)
    expect(persistence.saved[0].checkpoint).toMatchObject({
      turnIndex: 0,
      label: '[执行中] 执行完整计划',
    })
    expect(persistence.saved[0].checkpoint.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planStageId: 'stage-current',
          item: expect.objectContaining({ role: 'assistant', content: '总结：整个任务已完成' }),
        }),
      ]),
    )
    expect(persistence.saved.at(-1)?.checkpoint).toMatchObject({
      turnIndex: 0,
      label: '执行完整计划',
    })
  })

  it('计划连续两轮只返回文本、不调用工具时停止自动续跑', async () => {
    seedSession('plan-text-loop', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-text-loop').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-text-loop-plan',
      title: '循环保护计划',
      objective: '不能机械重复回复',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'plan-text-loop-stage',
        title: '当前阶段',
        objective: '调用工具完成工作',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    const { fetchImpl, count } = seqFetch([
      () => jsonResponse('在的。'),
      () => jsonResponse('你好！有什么可以帮你的？'),
      () => jsonResponse('这一轮不应再请求'),
    ])

    await runSession('plan-text-loop', '继续执行计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(count()).toBe(2)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'error',
      error: '计划执行连续 2 轮未调用工具，已停止自动续跑',
    })
    expect(
      store.getter(itemsAtom)
        .filter(({ item }) => item.role === 'assistant')
        .map(({ item }) => item.content),
    ).toEqual(['在的。', '你好！有什么可以帮你的？'])
  })

  it('计划续跑提醒带上上一次 submit_stage_result 的拒绝原因', async () => {
    seedSession('plan-submit-reject', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-submit-reject').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-submit-reject-plan',
      title: '提交拒绝提醒计划',
      objective: '提交失败原因必须回传模型',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [{
        id: 'stage-1',
        title: '当前阶段',
        objective: '提交阶段结果',
        deliverables: [],
        acceptanceCriteria: ['完成'],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    // submit_stage_result 未在本轮 tools 暴露（懒加载）→ 命中 schema_not_loaded，作为拒绝原因被记录。
    const responses: Array<() => Response> = [
      () => toolCallsResponse([{ name: 'submit_stage_result', args: { stageId: 'stage-1', summary: 's', evidence: [] } }]),
      () => jsonResponse('我已经完成了当前阶段的设计。'),
      () => jsonResponse('这一轮不应再请求'),
    ]
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
    let i = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(init!.body as string))
      const maker = responses[Math.min(i, responses.length - 1)]
      i += 1
      return maker()
    }

    await runSession('plan-submit-reject', '继续执行计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    // 第 3 次请求（text 轮之后）应注入含拒绝原因的续跑 system 提醒。
    expect(bodies).toHaveLength(3)
    const injected = bodies[2].messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    expect(injected).toContain('submit_stage_result 未成功')
    expect(injected).toContain('schema 尚未加载')
  })

  it('单个阶段连续占用超过阈值轮次仍不推进时，阶段进度 guard 硬暂停', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('plan-stage-guard', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-stage-guard').store
    const now = Date.now()
    // 3 阶段计划：总预算 = max(64, 32+3*24)=104；单阶段 guard=64（=MIN_PLAN_AGENT_TURNS）先于 max_turns 触发。
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-stage-guard-plan',
      title: '多阶段计划',
      objective: '验证阶段进度 guard',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        { id: 'stage-1', title: '阶段一', objective: 'x', deliverables: [], acceptanceCriteria: ['done'], dependencies: [], status: 'in_progress', evidence: [] },
        { id: 'stage-2', title: '阶段二', objective: 'x', deliverables: [], acceptanceCriteria: ['done'], dependencies: [], status: 'pending', evidence: [] },
        { id: 'stage-3', title: '阶段三', objective: 'x', deliverables: [], acceptanceCriteria: ['done'], dependencies: [], status: 'pending', evidence: [] },
      ],
    })
    let count = 0
    // 每轮都调工具（不走纯文本），避免撞上 stall guard；始终停留在 stage-1，不推进。
    const fetchImpl: typeof fetch = async () => {
      count += 1
      return toolCallsResponse([
        { name: 'request_tool_schema', args: { toolName: 'skill_search', reason: `guard-loop-${count}` } },
      ])
    }

    await runSession('plan-stage-guard', '执行计划', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    // guard 在第 65 轮开头触发（stageTurnsOnGuard 65>64），此前已发起 64 次请求。
    expect(count).toBe(64)
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('已连续占用超过 64 轮')
    expect(trace.events.some((event) => event.name === 'agent.plan_stage_over_budget')).toBe(true)
  })

  it('阶段进度 guard 跨恢复沿用持久化模型轮数，不因新 run 清零', async () => {
    seedSession('plan-stage-persisted-guard', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-stage-persisted-guard').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'plan-stage-persisted-guard-plan',
      title: '跨恢复阶段保护',
      objective: '同一阶段不能无限恢复',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        { id: 'stage-1', title: '阶段一', objective: 'x', deliverables: [], acceptanceCriteria: ['done'], dependencies: [], status: 'in_progress', evidence: [] },
        { id: 'stage-2', title: '阶段二', objective: 'x', deliverables: [], acceptanceCriteria: ['done'], dependencies: ['stage-1'], status: 'pending', evidence: [] },
      ],
    })
    store.setter(itemsAtom, [
      { id: 'user-1', createdAt: 1, item: { role: 'user', content: '执行计划' } },
      ...Array.from({ length: 64 }, (_, index) => ({
        id: `assistant-${index}`,
        createdAt: index + 2,
        planStageId: 'stage-1',
        item: { role: 'assistant' as const, content: `阶段执行 ${index + 1}` },
      })),
    ])
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      return jsonResponse('不应再请求')
    }

    await resumePlanSession('plan-stage-persisted-guard', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(requestCount).toBe(0)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('已连续占用超过 64 轮'),
    })
  })

  it('run 已 stopped 后，即使模型请求无视 abort 并返回也不会写回或续跑', async () => {
    seedSession('stop-ignoring-fetch', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('stop-ignoring-fetch').store
    let requestCount = 0
    let resolveResponse!: (response: Response) => void
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      return response
    }

    const running = runSession('stop-ignoring-fetch', '继续执行', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await waitUntil(() => requestCount === 1, 'model request started')
    const runId = store.getter(runAtom)?.runId
    expect(runId).toBeTruthy()
    patchRun('stop-ignoring-fetch', { status: 'stopped' })
    resolveResponse(jsonResponse('在的。'))
    await running

    expect(requestCount).toBe(1)
    expect(store.getter(runAtom)).toMatchObject({ runId, status: 'stopped' })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual(['user'])
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
    // ★ 回归：loop_detected 同样已往 itemsAtom 写过条目 —— 不落 checkpoint 整轮刷新即蒸发。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0].items.map((it) => it.item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
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

  it('模型收到旧 schema 后同名工具被重注册：旧响应不得执行新实例', async () => {
    const core = createCoreInstance()
    const id = 'tool-registration-changed'
    const toolName = 'dynamic_registration_guard'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })

    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    const inputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    }
    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '旧版动态工具', content: '旧版指南：按旧契约调用' },
      inputSchema,
      execute: oldExecute,
    })
    const oldRegistrationVersion = core.tools.registrationVersion(toolName)

    const requestBodies: Array<{ tools?: ModelFunctionTool[] }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { tools?: ModelFunctionTool[] })
      if (requestBodies.length === 1) {
        return toolCallsResponse([{
          name: 'request_tool_schema',
          args: { toolName, reason: '读取动态工具参数' },
          id: 'load-dynamic',
        }])
      }
      if (requestBodies.length === 2) {
        // 请求体已经把旧 schema 发给模型；在旧响应到达前模拟 MCP tools_changed/重连覆盖同名实例。
        core.tools.register({
          name: toolName,
          runtime: 'internal',
          skill: { description: '新版动态工具', content: '新版指南：实现已替换' },
          inputSchema,
          execute: newExecute,
        })
        return toolCallsResponse([{
          name: toolName,
          args: { value: '由旧 schema 生成' },
          id: 'stale-dynamic-call',
        }])
      }
      return jsonResponse('已重新加载工具')
    }

    await runSession(id, '调用动态工具', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const exposedTool = requestBodies[1]?.tools?.find((tool) => tool.function.name === toolName)
    expect(exposedTool?.function.description).toContain('旧版指南')
    expect(exposedTool?.function.description).not.toContain('新版指南')
    expect(core.tools.registrationVersion(toolName)).toBeGreaterThan(oldRegistrationVersion!)
    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()

    const staleResult = core.getSessionStore(id).store.getter(itemsAtom).find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'stale-dynamic-call',
    )?.item
    if (!staleResult || staleResult.role !== 'tool') throw new Error('缺少旧注册调用的拒绝结果')
    expect(JSON.parse(staleResult.content)).toMatchObject({
      code: 'tool_registration_changed',
      expectedRegistrationVersion: oldRegistrationVersion,
      currentRegistrationVersion: core.tools.registrationVersion(toolName),
    })
    expect(requestBodies).toHaveLength(3)
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
  })
})

describe('危险工具确认门（S4-B）', () => {
  beforeEach(() => {
    // 这一组验证桌面端 server 工具的参数校验与授权门；只有 Tauri 环境会向模型暴露这些 schema。
    tauriControl.enabled = true
  })

  it('危险 shell 参数缺 command：先 validation_failed 回填 tool error，不进入 waiting_confirmation', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('d-shell-invalid', { vendor: 'deepseek', model: 'x' })
    const expectedError = 'invalid shell_macos: command (non-empty string) is required'
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
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
    expect(count()).toBe(3)

    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant',
    ])
    const toolItem = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'sh1',
    )?.item
    if (!toolItem || toolItem.role !== 'tool') throw new Error('意外的条目形状')
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
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args, id: 'w1' }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d1').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('waiting_confirmation')
    expect(run?.pendingToolConfirmation).toEqual({
      callId: 'w1',
      toolName: 'write_file',
      args,
      registrationVersion: toolRegistry.registrationVersion('write_file'),
    })
    // schema 加载后暂停，没有续跑到最终文本。
    expect(count()).toBe(2)
    // schema call 已回填；危险工具的 ToolItem 未回填（留给 confirmTool）。
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(false)
    // 暂停不算收尾：不 commit checkpoint。
    expect(store.getter(checkpointsAtom)).toHaveLength(0)
  })

  it('只读 server 工具（read_file）：不触发确认，正常执行并续跑到 done', async () => {
    seedSession('d2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'read_file', reason: '需要读文件' },
      }]),
      () => toolCallsResponse([{ name: 'read_file', args: { path: 'a.txt' }, id: 'r1' }]),
      () => jsonResponse('读完了'),
    ])

    await runSession('d2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d2').store
    // 没有停在 waiting_confirmation，一路跑到 done。
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
    // read_file 已执行并回填了 ToolItem（tool_call_id=r1）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'r1')).toBe(true)
  })

  it('「本 session 一律允许」命中：危险工具不再确认，直接执行续跑', async () => {
    seedSession('d3', { vendor: 'deepseek', model: 'x' })
    // 预置：本 session 已一律允许 write_file。
    getSessionStore('d3').store.setter(alwaysAllowedToolsAtom, ['write_file'])
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' }]),
      () => jsonResponse('写完了'),
    ])

    await runSession('d3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d3').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
    // write_file 已执行并回填了 ToolItem（未暂停确认）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(true)
  })

  it('Auto：普通变更工具不确认，直接执行', async () => {
    seedSession('d-auto', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto': { ...prev['d-auto'], toolApprovalMode: 'auto' },
    }))
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' }]),
      () => jsonResponse('写完了'),
    ])

    await runSession('d-auto', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(getSessionStore('d-auto').store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
  })

  it('Auto：rm -rf * 仍暂停为极高风险确认', async () => {
    seedSession('d-auto-critical', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto-critical': { ...prev['d-auto-critical'], toolApprovalMode: 'auto' },
    }))
    const args = { command: 'rm -rf *' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
      () => toolCallsResponse([{ name: 'shell_macos', args, id: 'sh1' }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d-auto-critical', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const run = getSessionStore('d-auto-critical').store.getter(runAtom)
    expect(run?.status).toBe('waiting_confirmation')
    expect(run?.pendingToolConfirmation).toMatchObject({
      callId: 'sh1',
      toolName: 'shell_macos',
      args,
      risk: 'critical',
    })
    expect(count()).toBe(2)
  })

  it('Auto：普通 rm 不暂停，但工具结果明确标记不可撤回', async () => {
    seedSession('d-auto-rm', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto-rm': { ...prev['d-auto-rm'], toolApprovalMode: 'auto' },
    }))
    const args = { command: 'rm note.txt' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
      () => toolCallsResponse([{ name: 'shell_macos', args, id: 'rm1' }]),
      () => jsonResponse('执行完毕'),
    ])

    await runSession('d-auto-rm', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const store = getSessionStore('d-auto-rm').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(runAtom)?.pendingToolConfirmation).toBeUndefined()
    const result = store.getter(itemsAtom).find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'rm1',
    )?.item
    if (!result || result.role !== 'tool') throw new Error('缺少 rm tool result')
    expect(JSON.parse(result.content)).toMatchObject({ reversible: false })
    expect(count()).toBe(3)
  })

  it('危险工具与其它 tool_call 并列：先补齐其它工具 result 再暂停确认（不 orphan）', async () => {
    seedSession('d4', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
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
    expect(count()).toBe(2)
    const items = store.getter(itemsAtom)
    // 两次 request_tool_schema 均回填；write_file 的 result 留给确认恢复。
    expect(items.map((it) => it.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool',
    ])
    const toolItem = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'ts1',
    )?.item
    if (!toolItem || toolItem.role !== 'tool') throw new Error('意外的条目形状')
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

  it('MCP 工具等待确认后同名重注册：用户批准也不得执行新实例', async () => {
    const toolName = 'mcp__test__mutable_action'
    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return toolCallsResponse([{
          name: 'request_tool_schema',
          args: { toolName, reason: '读取 MCP 参数' },
          id: 'load-mcp',
        }])
      }
      if (requestCount === 2) {
        return toolCallsResponse([{
          name: toolName,
          args: { value: 'approved value' },
          id: 'pending-mcp-call',
        }])
      }
      return jsonResponse('已处理注册变化')
    }
    const core = createCore({
      config: { deepseekApiKey: 'k', fetchImpl },
    })
    const inputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    }
    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '旧 MCP 工具', content: '执行外部变更' },
      inputSchema,
      execute: oldExecute,
    })
    const oldRegistrationVersion = core.tools.registrationVersion(toolName)
    const id = core.newSession({ settings: { vendor: 'deepseek', model: 'x' } })

    core.sendMessage('执行 MCP 操作')
    await waitUntil(
      () => core.getSessionStore(id).store.getter(runAtom)?.status === 'waiting_confirmation'
        && !core.abort.isRunning(id),
      'MCP confirmation',
    )

    const pending = core.getSessionStore(id).store.getter(runAtom)?.pendingToolConfirmation
    expect(pending).toMatchObject({
      callId: 'pending-mcp-call',
      toolName,
      args: { value: 'approved value' },
      registrationVersion: oldRegistrationVersion,
    })
    expect(oldExecute).not.toHaveBeenCalled()

    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '新 MCP 工具', content: '重连后的另一实现' },
      inputSchema,
      execute: newExecute,
    })
    const newRegistrationVersion = core.tools.registrationVersion(toolName)
    expect(newRegistrationVersion).toBeGreaterThan(oldRegistrationVersion!)

    // 直接走用户“允许”命令，覆盖 pending 版本从 commands 到 resumeToolCall 的完整传递。
    core.confirmTool(true)
    await waitUntil(
      () => core.getSessionStore(id).store.getter(runAtom)?.status === 'done',
      'MCP confirmation resume',
    )

    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()
    const result = core.getSessionStore(id).store.getter(itemsAtom).find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'pending-mcp-call',
    )?.item
    if (!result || result.role !== 'tool') throw new Error('缺少确认恢复后的工具结果')
    const resultPayload = JSON.parse(result.content) as { error?: string }
    expect(resultPayload.error).toContain('tool registration version mismatch')
    expect(resultPayload.error).toContain(`expected ${oldRegistrationVersion}`)
    expect(resultPayload.error).toContain(`current ${newRegistrationVersion}`)
    expect(requestCount).toBe(3)
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

// ---------------------------------------------------------------------------
// finish_reason 异常三态（length / content_filter / insufficient_system_resource）
// ---------------------------------------------------------------------------
describe('finish_reason 异常分流', () => {
  it("length 且无 tool_calls：保留半截回复 + status=error，且整轮照常 commit 并落盘", async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([() => finishReasonResponse('length', '半截答案')])

    await runSession('fr1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr1').store
    const items = store.getter(itemsAtom)
    // 半截内容必须留下 —— 用户得看得见模型说到哪被掐断的。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    const assistantItem = items[1].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('半截答案')
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
    // ★ 回归（MAJOR）：itemsAtom 不持久化，落盘的唯一入口就是 commitCheckpoint + persistCheckpoint。
    //   这一轮若不落盘，用户刷新后不只半截答案没了，连他自己发的那条 user 消息也一起消失。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0].items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    expect(persistence.saved).toHaveLength(1)
    expect(persistence.saved[0].sessionId).toBe('fr1')
    expect(persistence.saved[0].checkpoint.items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    // 状态仍是 error（落盘不代表这轮算成功），也不再发第二次请求。
    expect(count()).toBe(1)
  })

  it('length 且流式：末尾未 flush 的文本必须补齐（不能只留最后一次节流快照）', async () => {
    seedSession('fr-stream', { vendor: 'deepseek', model: 'x' })
    // 两个 delta 在同一批 SSE 里被同步消费 —— 间隔远小于 STREAM_UPDATE_INTERVAL_MS(50ms)，
    // 于是第二次 flush 被节流丢掉，条目里只剩「前半段」。收尾必须把完整内容对账回去。
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        { choices: [{ delta: { content: '前半段' } }] },
        { choices: [{ delta: { content: '后半段' }, finish_reason: 'length' }] },
      ])

    await runSession('fr-stream', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-stream').store
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    // ★ 回归（MAJOR）：finishPending() 只写 { pending:false }、从不写 content，
    //   末尾那段文字只活在 streamWriter 闭包里 —— 界面会比实际收到的还少一截且毫无提示。
    const streamedItem = items[1].item
    if (streamedItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(streamedItem.content).toContain('前半段后半段')
    // 系统标注只能【追加】在完整正文之后，不能把流式对账出来的文本顶掉。
    expect(streamedItem.content?.startsWith('前半段后半段')).toBe(true)
    expect(items[1].pending).toBe(false)
    // 半截 assistant 条目绝不能带 tool_calls：本分支要 return、不执行工具，
    // 落下 tool_calls 就成了没有 result 的孤儿，下一轮重发直接被接口判非法。
    expect('tool_calls' in items[1].item).toBe(false)
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
  })

  it('length 且内容为空：报「触顶截断」而不是误导性的「模型返回空回复」', async () => {
    seedSession('fr2', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => finishReasonResponse('length', '')

    await runSession('fr2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('fr2').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
    expect(run?.error).not.toContain('空回复')
  })

  it('content_filter：status=error 且文案点名内容安全策略，content 为空仍补「仅含标注」的 assistant 条目', async () => {
    seedSession('fr3', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => finishReasonResponse('content_filter', null)

    await runSession('fr3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr3').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('content_filter')
    // ★ 回归：content 为 null（content_filter 的正常形态）不再意味着「什么条目都不留」——
    //   同 length 一样必须有落点，否则刷新后聊天区一片空白，且下一轮重发历史时模型看不出
    //   这里发生过什么（见 modelRun.ts 该分支的长注释）。
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    const assistantItem = items[1].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('content_filter')
    expect(assistantItem.content).toContain('系统标注')
    // 没有原始正文可拼接时，不应该让这条独立条目从一段空白换行起头。
    expect(assistantItem.content?.startsWith('\n')).toBe(false)
    // ★ 指代必须是「本轮回复」而不是「以上回复」★ ——
    //   这条是【独立条目】，它上面一条消息是用户的提问。说「以上回复被拦截」会指到用户身上：
    //   重发历史时模型看到 user → assistant('以上回复被拦截')，很可能理解成「用户的输入被拦截」，
    //   与「让模型知道自己上一轮输出出了什么事」的目标正好相反。
    expect(assistantItem.content).toContain('本轮回复')
    expect(assistantItem.content).not.toContain('以上回复')
  })

  it('DeepSeek insufficient_system_resource：无流式写回时原请求重试一次并恢复', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-recovered', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => finishReasonResponse('insufficient_system_resource', null),
      () => jsonResponse('容量恢复'),
    ])

    await runSession('fr-resource-recovered', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const store = getSessionStore('fr-resource-recovered').store
    expect(count()).toBe(2)
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(itemsAtom).map(({ item }) => item)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '容量恢复' },
    ])
    expect(trace.events.filter(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toHaveLength(1)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_recovered',
    )?.attrs).toMatchObject({
      retries_used: 1,
    })
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )).toBe(false)
  })

  it('DeepSeek insufficient_system_resource：最多重试一次，耗尽后仍走原异常收尾', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr4', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => finishReasonResponse('insufficient_system_resource', null),
    ])

    await runSession('fr4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const store = getSessionStore('fr4').store
    const run = store.getter(runAtom)
    expect(count()).toBe(2)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('insufficient_system_resource')
    expect(run?.error).toContain('稍后重试')
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant'])
    const assistantItem = items[1].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('insufficient_system_resource')
    expect(trace.events.filter(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toHaveLength(1)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      retries_used: 1,
      reason: 'retry_limit_reached',
    })
  })

  it('DeepSeek insufficient_system_resource：协议重试请求失败时闭合 exhausted 事件', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-retry-failed', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => finishReasonResponse('insufficient_system_resource', null),
      () => new Response('unauthorized', { status: 401 }),
    ])

    await runSession('fr-resource-retry-failed', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(count()).toBe(2)
    expect(getSessionStore('fr-resource-retry-failed').store.getter(runAtom)?.status).toBe('error')
    expect(trace.events.filter(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toHaveLength(1)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      retries_used: 1,
      reason: 'retry_request_failed',
    })
  })

  it('DeepSeek insufficient_system_resource：已有流式 delta 时禁止重试，保留原文并异常收尾', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-streamed', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return sseResponse([
        {
          choices: [{
            delta: { content: '已经写出的半截内容' },
            finish_reason: 'insufficient_system_resource',
          }],
        },
      ])
    }

    await runSession('fr-resource-streamed', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const store = getSessionStore('fr-resource-streamed').store
    expect(calls).toBe(1)
    expect(store.getter(runAtom)?.status).toBe('error')
    const assistant = store.getter(itemsAtom)[1]?.item
    if (!assistant || assistant.role !== 'assistant') throw new Error('缺少流式 assistant 条目')
    expect(assistant.content).toContain('已经写出的半截内容')
    expect(assistant.content).toContain('insufficient_system_resource')
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toBe(false)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      retries_used: 0,
      reason: 'streamed_output_already_written',
    })
  })

  it('DeepSeek insufficient_system_resource：非流式响应已有正文时禁止重试', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-json-content', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return finishReasonResponse(
        'insufficient_system_resource',
        '非流式响应里已经返回的正文',
      )
    }

    await runSession('fr-resource-json-content', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(calls).toBe(1)
    const store = getSessionStore('fr-resource-json-content').store
    expect(store.getter(runAtom)?.status).toBe('error')
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toBe(false)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      retries_used: 0,
      // JSON 兼容路径也会经统一 onDelta 写入流式条目，因此这里优先记录“已经写回”。
      reason: 'streamed_output_already_written',
      has_response_text: true,
    })
  })

  it('DeepSeek insufficient_system_resource：响应含 tool_calls 时禁止重试和执行', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-tools', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return rawToolCallsResponse('insufficient_system_resource', [{
        name: 'request_tool_schema',
        args: '{"toolName":"skill_search","reason":"容量不足前生成"}',
        id: 'resource-tool-call',
      }])
    }

    await runSession('fr-resource-tools', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const store = getSessionStore('fr-resource-tools').store
    expect(calls).toBe(1)
    expect(store.getter(runAtom)?.status).toBe('error')
    expect(store.getter(itemsAtom).some(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'resource-tool-call',
    )).toBe(false)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      retries_used: 0,
      reason: 'tool_calls_returned',
      tool_calls_count: 1,
    })
  })

  it('DeepSeek insufficient_system_resource：畸形原始 tool_calls 也禁止重试', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-malformed-tools', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'insufficient_system_resource',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'malformed-call',
              type: 'function',
              function: { arguments: '{}' },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await runSession('fr-resource-malformed-tools', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(calls).toBe(1)
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toBe(false)
    expect(trace.events.find(
      (event) => event.name === 'llm.insufficient_system_resource_exhausted',
    )?.attrs).toMatchObject({
      reason: 'tool_calls_returned',
      tool_calls_count: 0,
      raw_tool_calls_count: 1,
    })
  })

  it('GLM 不应用 DeepSeek insufficient_system_resource 协议重试', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-glm', { vendor: 'glm', model: 'glm-test' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return finishReasonResponse('insufficient_system_resource', null)
    }

    await runSession('fr-resource-glm', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(calls).toBe(1)
    expect(trace.events.some(
      (event) => event.name.startsWith('llm.insufficient_system_resource_'),
    )).toBe(false)
  })

  it('DeepSeek 容量重试遵守 AbortSignal：响应到达前 abort 后不再发请求', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-abort', { vendor: 'deepseek', model: 'x' })
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      controller.abort()
      return finishReasonResponse('insufficient_system_resource', null)
    }

    await runSession('fr-resource-abort', 'hi', {
      signal: controller.signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-abort').store.getter(runAtom)?.status).toBe('stopped')
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toBe(false)
  })

  it('DeepSeek 容量重试遵守 stale-run：旧响应到达后不得为新 run 再发请求', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr-resource-stale', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      setRun('fr-resource-stale', { runId: 'NEW-RUN', status: 'running' })
      return finishReasonResponse('insufficient_system_resource', null)
    }

    await runSession('fr-resource-stale', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-stale').store.getter(runAtom)).toMatchObject({
      runId: 'NEW-RUN',
      status: 'running',
    })
    expect(trace.events.some(
      (event) => event.name === 'llm.insufficient_system_resource_retry',
    )).toBe(false)
  })

  it('content_filter 补条目：刷新（落盘）和下一轮重发给模型都看得见「这里被拦截过」', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr-cf-mark', { vendor: 'deepseek', model: 'x' })
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      calls += 1
      return calls === 1 ? finishReasonResponse('content_filter', null) : jsonResponse('续上')
    }

    await runSession('fr-cf-mark', '敏感问题', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-cf-mark').store
    // ★ 回归 a：checkpoint（落盘的唯一真相源）里必须带着这条「仅含标注」的 assistant 条目，
    //   而不只是 checkpoint label 的 '[已拦截]' 前缀——否则刷新后聊天区看起来这轮什么都没发生。
    const checkpoint = store.getter(checkpointsAtom)[0]
    expect(checkpoint.label.startsWith('[已拦截]')).toBe(true)
    const committedAssistant = checkpoint.items[1].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('content_filter')
    expect(persistence.saved).toHaveLength(1)
    const savedAssistant = persistence.saved[0].checkpoint.items[1].item
    if (savedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(savedAssistant.content)).toContain('content_filter')

    // ★ 回归 b（更要紧）：下一轮重发给模型的历史里必须能看见这条标注，模型才知道
    //   「上一轮被内容安全策略拦截了」，而不是把两条 user 消息中间的空白当成什么都没发生过。
    await runSession('fr-cf-mark', '继续', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    const resent = bodies[bodies.length - 1].messages
    const resentAssistant = resent.find(
      (message) => message.role === 'assistant' && String(message.content).includes('content_filter'),
    )
    expect(resentAssistant).toBeDefined()
  })

  it('length 且带 tool_calls：不终止（终止会留下没有结果的 tool_calls），交给参数解析兜底', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr5', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      // arguments 被截断成半截 JSON —— 正是 finish_reason='length' 的典型产物。
      () => rawToolCallsResponse('length', [{ name: 'skill_search', args: '{"query": "cha', id: 'cut1' }]),
      () => jsonResponse('已重来'),
    ])

    await runSession('fr5', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const store = getSessionStore('fr5').store
    const items = store.getter(itemsAtom)
    // 关键：assistant(tool_calls) 后必须有对应的 tool 结果，否则下一轮消息序列非法。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('cut1')
    const payload = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(String(payload.error)).toContain('不是合法 JSON')
    expect(String(payload.argumentsPreview)).toContain('"query"')
    // 循环继续（TK6），模型重发后正常收尾。
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(trace.events.some((event) => event.name === 'llm.finish_length_tool_calls')).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.args_invalid')).toBe(true)
  })

  it('截断标记进持久化：正文带系统标注 + checkpoint label 带 [截断]，且重发给模型时仍看得见', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr-mark', { vendor: 'deepseek', model: 'x' })
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      calls += 1
      return calls === 1 ? finishReasonResponse('length', '第一步先算出 42') : jsonResponse('续上')
    }

    await runSession('fr-mark', '算个数', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-mark').store
    // ★ 回归 a（MAJOR）：承载 finishError 的 runAtom 不持久化，截断状态必须落在【持久化数据】上，
    //   否则刷新之后这半截回答与一条正常回复完全同形，CheckpointBar 上也分不出好坏。
    const checkpoint = store.getter(checkpointsAtom)[0]
    expect(checkpoint.label.startsWith('[截断]')).toBe(true)
    const committedAssistant = checkpoint.items[1].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('第一步先算出 42')
    expect(String(committedAssistant.content)).toContain('finish_reason=length')
    // 落盘的那一份（刷新后唯一的真相源）必须同样带着标注与 label 前缀。
    expect(persistence.saved).toHaveLength(1)
    expect(persistence.saved[0].checkpoint.label.startsWith('[截断]')).toBe(true)
    const savedAssistant = persistence.saved[0].checkpoint.items[1].item
    if (savedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(savedAssistant.content)).toContain('finish_reason=length')

    // ★ 回归 b（更要紧）：这条半截文本会作为历史在之后每一轮被重发给模型。模型必须看得出
    //   「上文这里被截断过」，否则会把半截推理当成已成立的结论继续往下走。
    await runSession('fr-mark', '继续', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    const resent = bodies[bodies.length - 1].messages
    const resentAssistant = resent.find(
      (message) => message.role === 'assistant' && String(message.content).includes('第一步先算出 42'),
    )
    expect(resentAssistant).toBeDefined()
    expect(String(resentAssistant?.content)).toContain('finish_reason=length')
    // 标注只是【追加】—— 模型原话一字不改地留在前面。
    expect(String(resentAssistant?.content).startsWith('第一步先算出 42')).toBe(true)
  })

  it('正常轮不被标记污染：assistant 正文一字不加，checkpoint label 也不带前缀', async () => {
    seedSession('fr-clean', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('完整答案')

    await runSession('fr-clean', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-clean').store
    expect(store.getter(itemsAtom)[1].item).toEqual({ role: 'assistant', content: '完整答案' })
    expect(store.getter(checkpointsAtom)[0].label).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// 收尾（finally）里的 delegateRuntime.dispose
// ---------------------------------------------------------------------------
describe('收尾 dispose 的异常隔离', () => {
  it('dispose 抛错：不从 runToolLoop 逃逸，run 结局与 checkpoint 都保持完好', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // ★ 回归：finally 与外层 try/catch 是平级的 —— dispose 一抛，异常直接从 runToolLoop 逃逸，
    //   绕过刚做完的降级逻辑：run 停在最后一次 patchRun 的值上，调用方的 endRun 执行与否看天。
    disposeControl.error = new Error('dispose boom')
    seedSession('dp1', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('你好')

    await expect(
      runSession('dp1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl }),
    ).resolves.toBeUndefined()
    await flushObservability()

    const store = getSessionStore('dp1').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    // 吞掉不等于假装没发生：留一条 trace。
    const disposeEvent = trace.events.find((event) => event.name === 'agent.dispose_failed')
    expect(disposeEvent).toBeDefined()
    expect(String(disposeEvent?.attrs?.error)).toContain('dispose boom')
  })

  it('dispose 抛 AbortError：同样不逃逸，stopped 结局不被改写', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // 走到 finally 时本轮结局早已判完（这里是 stopped）。把 dispose 的 AbortError 再抛出去，
    // 只会把一个已经收好的 run 变成 reject —— 没有任何人会再消费它。
    const abortErr = new Error('The operation was aborted.')
    abortErr.name = 'AbortError'
    disposeControl.error = abortErr
    seedSession('dp2', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException('aborted', 'AbortError')
    }

    await expect(
      runSession('dp2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl }),
    ).resolves.toBeUndefined()
    await flushObservability()

    expect(getSessionStore('dp2').store.getter(runAtom)?.status).toBe('stopped')
    const disposeEvent = trace.events.find((event) => event.name === 'agent.dispose_failed')
    expect(disposeEvent?.attrs?.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tool_call 参数解析：坏 JSON 不执行工具，但必须回填错误结果
// ---------------------------------------------------------------------------
describe('tool_call 参数解析', () => {
  it('参数是坏 JSON：不执行工具、回填错误 tool 结果让模型重发', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: { done: true } }
      },
    })
    seedSession('pa1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy__', args: '这不是 JSON', id: 'bad1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 坏参数绝不能被降级成 {} 后照常执行 —— 那等于拿默认参数干活。
    expect(executed).toBe(0)
    const items = getSessionStore('pa1').store.getter(itemsAtom)
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    const payload = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(String(payload.error)).toContain('不是合法 JSON')
    expect(String(payload.hint)).toContain('JSON 对象')
  })

  it('参数是 JSON 但不是对象（数组/标量）：同样回填错误，不执行', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy2__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: {} }
      },
    })
    seedSession('pa2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy2__', args: '[1,2,3]', id: 'bad2' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(executed).toBe(0)
    const toolItem = getSessionStore('pa2').store.getter(itemsAtom)[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(String((JSON.parse(toolItem.content) as Record<string, unknown>).error)).toContain('必须是 JSON 对象')
  })

  it('空 arguments 仍是合法的无参调用：照常执行', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy3__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: { ok: 1 } }
      },
    })
    seedSession('pa3', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: '__args_spy3__', reason: '需要测试空参数' },
      }]),
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy3__', args: '', id: 'empty1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(executed).toBe(1)
    expect(getSessionStore('pa3').store.getter(runAtom)?.status).toBe('done')
  })

  it('坏参数反复重发：签名降级用原始字符串，循环检测照样命中（不抛错）', async () => {
    seedSession('pa4', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () =>
      rawToolCallsResponse('tool_calls', [{ name: 'skill_search', args: '{"query":', id: 'loop1' }])

    await runSession('pa4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('pa4').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('重复工具调用循环')
  })
})

// ---------------------------------------------------------------------------
// 上下文压缩接入（A4）
// ---------------------------------------------------------------------------
describe('上下文压缩接入', () => {
  it('未超预算：请求体就是原始 messages，不产生压缩事件', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('cc0', { vendor: 'deepseek', model: 'deepseek-chat' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('好'))
    }

    await runSession('cc0', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    // 固定 system + user + 尾部动态 skill context，一条没少。
    expect((captured.messages as unknown[]).length).toBe(3)
    expect(trace.events.some((event) => event.name === 'llm.context_compacted')).toBe(false)
    expect(trace.events.some((event) => event.name === 'llm.context_over_budget')).toBe(false)
  })

  it('超预算：请求体里的历史工具正文被摘要，但 itemsAtom 原文纹丝不动（真相源不可变）', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // max_tokens 把预算吃光 → 必然触发压缩（不必造一个几十万字的会话）。
    // ★ 刻意用表里【没有】的 model 名 'x' ★ —— 这里验的是压缩接线，不是某个真实模型的窗口。
    //   写真实模型名会把这个测试钉死在 MODEL_CONTEXT_WINDOW_TOKENS 的具体数值上：官方一改窗口
    //   （deepseek-chat 就从 64K 改成了 1M），这条与模型无关的测试就会无辜地红掉。
    //   'x' 查不到条目 → 落到 vendor 兜底 64_000，预算基准稳定。
    seedSession('cc1', { vendor: 'deepseek', model: 'x', max_tokens: 63_500 })
    const store = getSessionStore('cc1').store
    const bigResult = JSON.stringify({ data: 'x'.repeat(4000) })
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一轮' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_search', arguments: '{}' } }],
        },
      },
      { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'c1', content: bigResult } },
      { id: 'a2', createdAt: 4, item: { role: 'assistant', content: '第一轮答复' } },
      { id: 'u2', createdAt: 5, item: { role: 'user', content: '第二轮' } },
    ])
    setRun('cc1', { runId: 'CC1', status: 'running' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('好'))
    }

    await runToolLoop('cc1', 'CC1', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const sentMessages = captured.messages as Array<Record<string, unknown>>
    const sentTool = sentMessages.find((message) => message.role === 'tool')
    // 请求体里那条 tool 结果已被摘要成占位（带 _compacted 标记）。
    expect(String(sentTool?.content)).toContain('_compacted')
    expect(String(sentTool?.content).length).toBeLessThan(bigResult.length)
    // ★ 真相源不可变：itemsAtom 里仍是完整原文，压缩只是请求时的一次性投影。
    const items = store.getter(itemsAtom)
    const storedTool = items[2].item
    if (storedTool.role !== 'tool') throw new Error('意外的条目形状')
    expect(storedTool.content).toBe(bigResult)
    // checkpoint 里同样是原文，不是压缩后的投影。
    const checkpoint = store.getter(checkpointsAtom)[0]
    const checkpointTool = checkpoint?.items.find((it) => it.item.role === 'tool')?.item
    if (checkpointTool && checkpointTool.role === 'tool') {
      expect(checkpointTool.content).toBe(bigResult)
    }
    // contextStats 与真正发出去的是同一个数组（UI 用量和实际请求必须对得上）。
    expect(store.getter(contextStatsAtom)?.messagesCount).toBe(sentMessages.length)
    // 压缩可见性：trace 能看出压了、压了多少。
    const compacted = trace.events.find((event) => event.name === 'llm.context_compacted')
    expect(compacted).toBeDefined()
    expect(Number(compacted?.attrs?.summarized_tool_results)).toBeGreaterThan(0)
    // attr 名用 _tk 后缀而非 *_tokens：带 "token" 子串的 key 会被 redact 抹成 '[REDACTED]'。
    expect(Number(compacted?.attrs?.est_after_tk)).toBeLessThan(Number(compacted?.attrs?.est_before_tk))
    // 预算被吃光 → 压完仍超预算，但 run 照跑不误（不因此中止）。
    expect(trace.events.some((event) => event.name === 'llm.context_over_budget')).toBe(true)
    expect(store.getter(runAtom)?.status).toBe('done')
    // 这条会话用的是兜底窗口（64K），远小于成本软上限 → 压缩是被【硬窗口】逼出来的。
    expect(compacted?.attrs?.budget_source).toBe('window')
  })

  // Core 抽离 Stage 1 回归钉子：压缩已从 loop 内联搬进 compactionPlugin 的 transformContext 槽。
  //   专防【结构搬迁】才会引入、而上面那些 .find()/.some() 断言【抓不到】的两个新隐患：
  //   1) 双发 —— loop 里原本那两个 traceEvent 已删；若哪天被加回来（或插件与 loop 同时发），
  //      同名事件就各发两遍。.find()/.some() 只看「有没有」，看不出「几遍」，故这里数个数 === 1。
  //   2) 脱线 —— 插件必须复用 loop 经 makeCoreCtx 注入的 traceEvent 闭包，事件才会自动带上
  //      baseTraceAttrs（sessionId/runId/turnId）。若插件改用某个裸 emitter，事件照发得出，
  //      但会丢掉这层身份；这三个 id 都不由插件的事件 attrs 提供，全靠那层闭包，断言带全即钉住接线。
  it('压缩事件恰好各发一遍且带 baseTraceAttrs（防双发 / 防插件脱离 loop 的 traceEvent 闭包）', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // 与「超预算」用例同构：max_tokens 吃光兜底窗口预算 → 必触发压缩，且压完仍超预算。
    seedSession('cc5', { vendor: 'deepseek', model: 'x', max_tokens: 63_500 })
    const store = getSessionStore('cc5').store
    const bigResult = JSON.stringify({ data: 'z'.repeat(4000) })
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一轮' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_search', arguments: '{}' } }],
        },
      },
      { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'c1', content: bigResult } },
      { id: 'u2', createdAt: 4, item: { role: 'user', content: '第二轮' } },
    ])
    setRun('cc5', { runId: 'CC5', status: 'running' })
    // 普通回复（无 tool_calls）→ 单轮收尾，压缩只在这一轮跑一次。
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse('好'))

    await runToolLoop('cc5', 'CC5', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    // 各自恰好一条：双发会让某个 length 变成 2，这条测试即红。
    const compactedEvents = trace.events.filter((event) => event.name === 'llm.context_compacted')
    const overBudgetEvents = trace.events.filter((event) => event.name === 'llm.context_over_budget')
    expect(compactedEvents.length).toBe(1)
    expect(overBudgetEvents.length).toBe(1)
    // 身份三件套全在 → 插件确实经 loop 注入的 traceEvent 闭包发出（未脱线到裸 emitter）。
    //   turnId 取「本轮起头 user」= 最后一条 user（u2），由 runToolLoop 从 currentTurnItems 推得。
    for (const event of [compactedEvents[0], overBudgetEvents[0]]) {
      expect(event?.attrs?.sessionId).toBe('cc5')
      expect(event?.attrs?.runId).toBe('CC5')
      expect(event?.attrs?.turnId).toBe('u2')
    }
  })

  // 窗口表按官方文档校准到 1M 之后，硬窗口预算 ≈ 910K，压缩几乎永不触发 —— 而它此前一直
  // 兼职着成本闸门。这条钉住「成本软上限」这道与硬窗口解耦的第二道刹车：没有它，长会话每轮
  // 都会发出接近 900K token 的请求，用户在毫无提示的情况下烧掉可观费用。
  it('大窗口模型：压缩由成本软上限触发，而不是硬窗口（防账单失控）', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // ★ 刻意【不】硬编码 1M / 200K 这两个具体数值 ★ —— 只断言两者的【关系】。
    //   官方一改窗口（deepseek-chat 就从 64K 变成过 1M），硬编码的测试会无辜红掉；
    //   而「大窗口模型的预算应当被软上限夹住」这个不变量与具体数值无关。
    //   用 max_tokens 吃掉软上限内的预算即可触发压缩，不必真造 20 万 token 的会话。
    seedSession('cc4', { vendor: 'deepseek', model: 'deepseek-v4-pro', max_tokens: 190_000 })
    const store = getSessionStore('cc4').store
    const bigResult = JSON.stringify({ data: 'y'.repeat(4000) })
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一轮' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_search', arguments: '{}' } }],
        },
      },
      { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'c1', content: bigResult } },
      { id: 'u2', createdAt: 4, item: { role: 'user', content: '第二轮' } },
    ])
    setRun('cc4', { runId: 'CC4', status: 'running' })
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse('好'))

    await runToolLoop('cc4', 'CC4', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const compacted = trace.events.find((event) => event.name === 'llm.context_compacted')
    expect(compacted).toBeDefined()
    // 压缩是被成本软上限逼出来的，不是硬窗口。
    expect(compacted?.attrs?.budget_source).toBe('cost_cap')
    // 实际预算被夹到远小于该模型的真实窗口。
    expect(Number(compacted?.attrs?.budget_tk)).toBeLessThan(
      Number(compacted?.attrs?.context_window_tk),
    )
  })
  // 请求路径兜底：seedSession 直接写 sessionsAtom、【不经 hydrate】—— 正是「绕过 hydrate 迁移」
  // 的场景。会话带着已下线的 deepseek-chat / deepseek-reasoner，发出去的主 Agent 请求必须
  // 收口到 Pro，且 deepseek-reasoner 要连带把 thinking 补成 enabled（旧名隐含思考模式）。
  describe('主 Agent 模型在发请求前归一化（hydrate 之外的最后一道防线）', () => {
    async function capturedRequestFor(settings: ModelSettings): Promise<Record<string, unknown>> {
      seedSession('mig1', settings)
      let captured: Record<string, unknown> = {}
      const fetchImpl: typeof fetch = (_url, init) => {
        captured = JSON.parse(init!.body as string)
        return Promise.resolve(jsonResponse('ok'))
      }
      await runSession('mig1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
      return captured
    }

    it('deepseek-chat → v4-pro 且 thinking 显式 disabled（保留旧非思考行为）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-chat' })
      expect(body.model).toBe('deepseek-v4-pro')
      // 旧 deepseek-chat = 非思考模式；模型收口到 Pro 时仍保留旧名隐含的模式语义。
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it('deepseek-reasoner → v4-pro 且 thinking 补成 enabled（旧名隐含思考模式）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-reasoner' })
      expect(body.model).toBe('deepseek-v4-pro')
      expect(body.thinking).toEqual({ type: 'enabled' })
    })

    it('用户显式关了 thinking → 迁移不覆盖他的选择（thinking 优先于旧名隐含语义）', async () => {
      const body = await capturedRequestFor({
        vendor: 'deepseek',
        model: 'deepseek-reasoner',
        thinking: false,
      })
      expect(body.model).toBe('deepseek-v4-pro')
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it('未下线的模型名原样发出（兜底不误伤自定义/新模型名）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-v4-pro' })
      expect(body.model).toBe('deepseek-v4-pro')
    })
  })
})
