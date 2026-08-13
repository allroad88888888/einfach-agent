// P-R2 最小单轮 run 的单测（红→绿）。
// ---------------------------------------------------------------------------
// 契约 U5：只 input→model→reply（不做 lazy tools/多 agent/pipeline）。
// 契约 U7：signal 全穿透 + 失败降级（AbortError→stopped；其它→error），绝不抛崩。
// 只依赖状态层 + api 层；mock fetchImpl 注入模型响应/异常。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { contextCheckpointAtom, itemsAtom, runAtom, checkpointsAtom, planAtom } from '../state/sessionAtoms'
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
import { buildToolManifestText } from './modelTurn'
import type { ModelSettings } from '../state/core.type'
import type { ModelFunctionTool, ModelUsage } from '@web-agent/ai'
import {
  persistCurrentRunRecovery,
  resumeInterruptedSession,
  resumePlanSession,
  runSession,
  runToolLoop,
} from './modelRun'
import { configurePersistence, resetPersistence } from './persistenceBridge'
import type { Checkpoint } from '../state/checkpoint.type'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import { configureDefaultDelegation, createCoreInstance, defaultCore } from './core/coreInstance'
import { createCore } from './core/createCore'
import { buildSkillManifestText, registerStandardTools } from '@web-agent/tools'
import { createDelegateAgentRuntime, createSubagentScheduler } from '@web-agent/subagents'
import type { PlanRuntimeFactory } from '../planning/runtime'
import type { CreatePlanInput, PlanRuntimeStore } from '../planning/types'

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
vi.mock('@web-agent/subagents', async () => {
  const actual = await vi.importActual<typeof import('@web-agent/subagents')>('@web-agent/subagents')
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
  defaultCore.planRuntime = undefined
  configureDefaultDelegation(null)
})

function installDefaultDelegationForDisposeTest(): void {
  configureDefaultDelegation(() => {
    const scheduler = createSubagentScheduler()
    return {
      scheduler,
      async createRuntime(input) {
        return createDelegateAgentRuntime({ ...input, scheduler })
      },
    }
  })
}

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
  it('passes only the current CoreInstance model user identity into the request body', async () => {
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
    expect(items).toHaveLength(3)
    expect(items[0].item).toEqual({ role: 'user', content: 'hi' })
    expect(items[2].item).toEqual({ role: 'assistant', content: '你好' })

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
    persistCurrentRunRecovery('queued-final')
    expect(store.getter(checkpointsAtom)[0].recovery?.queuedUserMessages).toEqual([
      expect.objectContaining({
        id: 'queued-user-1',
        content: '再补充第二件事',
        targetRunId: runId,
      }),
    ])

    resolveFirst(jsonResponse('第一件事完成'))
    await running

    expect(requestCount).toBe(2)
    expect(store.getter(runAtom)).toMatchObject({ runId, status: 'done' })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'assistant',
    ])
    expect(store.getter(itemsAtom)[3]).toMatchObject({
      id: 'queued-user-1',
      createdAt: queuedAt,
      item: { role: 'user', content: '再补充第二件事' },
    })
    expect(bodies[1].messages.filter(({ role }) => role !== 'system').map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'tool',
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
      'tool',
      'assistant',
      'tool',
      'user',
      'assistant',
    ])
    expect(bodies[1].messages.filter(({ role }) => role !== 'system').map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'user',
    ])
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
  })

  it('abort：fetchImpl 抛 AbortError → run.status=stopped，不抛崩', async () => {
    seedSession('s2', { vendor: 'deepseek', model: 'x' })
    const persistence = captureCheckpointPersistence()
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
    // user 与 sessionStart 清单已写入；assistant 未写回。
    expect(getSessionStore('s2').store.getter(itemsAtom)).toHaveLength(2)
    // stopped 轮也必须形成可撤回快照；否则刷新会丢 user，继续对话后该消息也没有气泡回退入口。
    const checkpoints = getSessionStore('s2').store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ label: '[已停止] hi', kind: 'stopped' })
    expect(persistence.saved.at(-1)).toMatchObject({
      sessionId: 's2',
      checkpoint: { turnIndex: 0, label: '[已停止] hi', kind: 'stopped' },
    })
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
    expect(getSessionStore('s2b').store.getter(itemsAtom)).toHaveLength(2)
  })

  it('其它错误：fetchImpl 抛普通 Error → run.status=error 且隐藏传输细节', async () => {
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
    expect(run?.error).toBe('Chat completion transport failed (network_error).')
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
    expect(items).toHaveLength(3)
    expect(items[2].item).toEqual({ role: 'assistant', content: 'hi from glm' })
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
    const restoredSettings = rootStore.getter(sessionsAtom).s5.settings
    expect(restoredSettings.vendor === 'deepseek' ? restoredSettings.temperature : undefined).toBe(0.5)
  })

  it('L1 清单以 sessionStart timed tool 可达模型，稳定前缀和转录不再注入 skills', async () => {
    const workspaceRoot = '/workspace/project-skills'
    const projectSkills = {
      workspaceRoot,
      entries: [{
        name: 'project/release-check',
        description: '何时用：发布前检查部署流程。',
        triggers: ['发布'],
        filePath: '.agents/skills/release-check/SKILL.md',
        resources: {},
        origin: 'agent' as const,
      }],
      diagnostics: [],
    }
    const projectSkillsProvider = vi.fn(async () => projectSkills)
    const core = createCoreInstance({ registerTools: registerStandardTools, projectSkillsProvider })
    const id = 'inject1'
    core.rootStore.setter(workspacesAtom, {
      workspace: { id: 'workspace', name: '项目 skills', rootPath: workspaceRoot, createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        workspaceId: 'workspace',
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const store = core.getSessionStore(id).store
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'system')).toBe(false)
    expect(items.map(({ item }) => item.role)).toEqual(['user', 'tool', 'assistant'])
    const timedItem = items.find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'timed:sessionStart:skill_manifest',
    )?.item
    if (!timedItem || timedItem.role !== 'tool') throw new Error('缺少 sessionStart skills 清单')

    const messages = captured.messages as Array<{
      role: string
      content?: string | null
      tool_call_id?: string
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).not.toContain('可用 skills')
    expect(messages[0].content).toContain('禁止凭工具名猜参数')
    // stable prefix 只有固定 system、工具摘要和环境；L1 在首轮 user 之后以 timed result 到达模型。
    expect(messages.map((item) => item.role)).toEqual(['system', 'system', 'system', 'user', 'assistant', 'tool'])
    expect(messages[1].content).toBe(buildToolManifestText(false, { registry: core.tools }))
    expect(messages[1].content).toContain('· skill_search [internal]')
    expect(messages[1].content).not.toContain('· shell_macos [server]')
    expect(messages[2].content).toContain('运行环境：')
    expect(messages[3]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'timed:sessionStart:skill_manifest',
        type: 'function',
        function: { name: 'timed_tool_result', arguments: '{}' },
      }],
    })
    expect(messages[5]).toMatchObject({ role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest' })
    const manifestText = JSON.parse(String(messages[5].content)) as string
    expect(manifestText).toBe(buildSkillManifestText(projectSkills))
    expect(manifestText).toBe(JSON.parse(timedItem.content))
    expect(manifestText).toContain('· planning — 何时用：任务跨多个阶段/模块')
    expect(manifestText).toContain('· project/release-check — 何时用：发布前检查部署流程。')
    expect(projectSkillsProvider).toHaveBeenCalledExactlyOnceWith(workspaceRoot)

    const events = store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.title === '注入 skill 清单')).toBe(false)
    expect(
      events.some((event) =>
        event.kind === 'system_injection'
        && event.title === '注入工具摘要清单'
        && event.detail === buildToolManifestText(false, { registry: core.tools })),
    ).toBe(true)
    expect(events.some((event) => event.kind === 'tool_manifest' && event.detail?.includes('request_tool_schema'))).toBe(
      true,
    )
  })

  it('Tauri 首轮请求能发现 shell_macos，但未加载前仍不把它作为可调用 function 暴露', async () => {
    tauriControl.enabled = true
    seedSession('inject-tauri-tools', { vendor: 'deepseek', model: 'm' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession('inject-tauri-tools', '检查本机项目', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const messages = captured.messages as Array<{ role: string; content?: string }>
    expect(messages[1].content).toBe(buildToolManifestText(true, { registry: toolRegistry }))
    expect(messages[1].content).toContain('· shell_macos [server]')

    const exposedToolNames = (captured.tools as ModelFunctionTool[])
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(['request_tool_schema'])
  })

  it('稳定前缀四段有序：固定 system → 工具摘要 → 自定义指令 → 运行环境；L1 走历史 timed item', async () => {
    // 清单由 sessionStart 工具写入历史，不再把 workspace skill 的变动纳入 stable prefix。其余低频
    // 内容仍按变更频率固定，环境垫底以尽量让不同 workspace 共享此前缀。
    const core = createCoreInstance({
      config: { customInstructions: '  请始终使用中文回复\n' },
      registerTools: registerStandardTools,
    })
    const id = 'custom-instructions-prefix'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const marker = '用户在设置中保存了以下长期自定义指令'
    const messages = captured.messages as Array<{ role: string; content?: string }>
    // [固定 system, 工具摘要, 自定义指令, 运行环境, user, timed 配对 assistant, timed tool]。
    expect(messages.map((item) => item.role)).toEqual(['system', 'system', 'system', 'system', 'user', 'assistant', 'tool'])
    expect(messages[0].content).toContain('禁止凭工具名猜参数')
    expect(messages[0].content).not.toContain(marker)
    expect(messages[1].content).toBe(buildToolManifestText(false, { registry: core.tools }))
    expect(messages[2].content).toContain(marker)
    expect(messages[2].content).toContain('请始终使用中文回复')
    expect(messages[3].content).toContain('运行环境：')
    expect(messages[4]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[5]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'timed:sessionStart:skill_manifest' }],
    })
    expect(messages[6]).toMatchObject({ role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest' })
    // 自定义指令只此一份，且不在历史之后。
    expect(messages.filter((item) => item.content?.includes(marker))).toHaveLength(1)

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.kind === 'system_injection' && event.detail?.includes(marker))).toBe(true)
  })

  it('运行环境段把会话绑定的 workspace 根目录送进请求（缺它模型只能猜路径）', async () => {
    // 回归用例。缺这一段时的实测事故：DeepSeek 首轮直接对
    // /Users/<某人>/develop/android/... 发 read_file，报 WORKSPACE_READ_FAILED，
    // 模型是从错误文案里才第一次看到真实根目录，白烧三轮。
    tauriControl.enabled = true
    const core = createCoreInstance()
    const id = 'env-workspace'
    core.rootStore.setter(workspacesAtom, {
      ws1: { id: 'ws1', name: 'web-agent', rootPath: '/Volumes/work/ai/web-agent/', createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        workspaceId: 'ws1',
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, '了解下这个项目', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    const messages = captured.messages as Array<{ role: string; content?: string }>
    const environment = messages[2]
    // 运行环境是稳定前缀最后一段。
    expect(environment?.role).toBe('system')
    expect(environment?.content).toContain('当前工作区根目录：/Volumes/work/ai/web-agent')
    expect(environment?.content).not.toContain('/Volumes/work/ai/web-agent/\n')
    expect(messages[3]).toMatchObject({ role: 'user', content: '了解下这个项目' })

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    expect(
      events.some((event) => event.title === '注入运行环境' && event.detail?.includes('/Volumes/work/ai/web-agent')),
    ).toBe(true)
  })

  it('注入卡片改为按内容变化判重：同一会话连续两次 runSession 不重复记同一张卡', async () => {
    // 本用例未注册 sessionStart 工具；稳定 system 注入的判重不依赖 skills。
    const core = createCoreInstance({ config: { customInstructions: '保持简洁' } })
    const id = 'inject-dedup'
    core.rootStore.setter(sessionsAtom, {
      [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'm' }, createdAt: 0, updatedAt: 0 },
    })
    const fetchImpl: typeof fetch = async () => jsonResponse('ok')

    await runSession(id, '第一句话', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    await runSession(id, '第二句话', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    // 五类稳定注入卡片各自只有一条——第二次 run 内容与第一次逐字相同，不应再记。
    expect(events.filter((e) => e.title === '注入 system')).toHaveLength(1)
    expect(events.filter((e) => e.title === '注入运行环境')).toHaveLength(1)
    expect(events.filter((e) => e.title === '注入自定义指令')).toHaveLength(1)
    expect(events.filter((e) => e.title === '注入 skill 清单')).toHaveLength(0)
    expect(events.filter((e) => e.title === '注入工具摘要清单')).toHaveLength(1)
    expect(events.filter((e) => e.title === '注入 tools')).toHaveLength(1)
    // 且不应出现任何「已更新」变体——内容确实没变。
    expect(events.some((e) => e.title === '自定义指令已更新')).toBe(false)
    expect(events.some((e) => e.title === '工具集已更新')).toBe(false)
  })

  it('自定义指令变化才记：不变不记，改动记「已更新」，清空记「已清除」', async () => {
    const core = createCoreInstance({ config: { customInstructions: '请始终使用中文回复' } })
    const id = 'custom-instructions-dedup'
    core.rootStore.setter(sessionsAtom, {
      [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'm' }, createdAt: 0, updatedAt: 0 },
    })
    const fetchImpl: typeof fetch = async () => jsonResponse('ok')
    const marker = '用户在设置中保存了以下长期自定义指令'
    const store = core.getSessionStore(id).store
    const byMarker = () => store.getter(runtimeTranscriptEventsAtom).filter((e) => e.detail?.includes(marker))

    // 第一次 run：首次出现 → 记「注入自定义指令」。
    await runSession(id, 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    expect(byMarker()).toHaveLength(1)
    expect(byMarker()[0].title).toBe('注入自定义指令')

    // 第二次 run：指令未变 → 不重复记。
    await runSession(id, 'hi again', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    expect(byMarker()).toHaveLength(1)

    // 两次 run 之间修改指令 → 第三次 run 记「已更新」。
    core.config.customInstructions = '请始终使用英文回复'
    await runSession(id, 'hi third', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    expect(byMarker()).toHaveLength(2)
    expect(byMarker()[1].title).toBe('自定义指令已更新')

    // 清空指令 → 第四次 run 记「已清除」。
    core.config.customInstructions = ''
    await runSession(id, 'hi fourth', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    const cleared = store.getter(runtimeTranscriptEventsAtom).filter((e) => e.title === '自定义指令已清除')
    expect(cleared).toHaveLength(1)
    // 清空之后 messages 里不应再带自定义指令 system 消息。
    expect(byMarker()).toHaveLength(2)
  })

  it('单 run 多 turn：懒加载新工具后 tools 卡片恰好两条（首 turn + 指纹变化 turn）', async () => {
    const core = createCoreInstance()
    const id = 'tools-dedup'
    const toolName = 'dedup_dynamic_tool'
    core.rootStore.setter(sessionsAtom, {
      [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })
    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '判重测试用动态工具', content: '指南：直接返回成功' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ ok: true as const, data: {} }),
    })

    const { fetchImpl } = seqFetch([
      // turn 1：请求加载新工具 schema（此时可见工具集里还没有它 → 第 1 张 tools 卡）。
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName, reason: '需要它' }, id: 'load1' }]),
      // turn 2：schema 已加载，可见工具集变化 → 第 2 张 tools 卡；随后调用该工具。
      () => toolCallsResponse([{ name: toolName, args: {}, id: 'call1' }]),
      // turn 3：可见工具集与 turn 2 相同 → 不应新增卡片；模型给出最终回复。
      () => jsonResponse('done'),
    ])

    await runSession(id, '用动态工具', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    const toolEvents = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
      .filter((e) => e.kind === 'tool_manifest')
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0].title).toBe('注入 tools')
    expect(toolEvents[1].title).toBe('工具集已更新')
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
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
    // 固定 system + 工具摘要 + 运行环境；L1 是历史中的 timed tool 与投影出的 assistant 配对。
    expect(stats?.roles.system.count).toBe(3)
    expect(stats?.roles.user.count).toBe(1)
    expect(stats?.roles.assistant.count).toBe(1)
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

  it('空回复：model 返回空 content → error，不写空 assistant，保留无恢复标记的工作 checkpoint', async () => {
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
    // 用户消息已在请求前写进同一工作 checkpoint；error 会清掉 recovery，刷新后不会误报可继续。
    const checkpoints = getSessionStore('s6').store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ label: 'hi', kind: 'working', recovery: undefined })
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

  it('旧 run 被顶替后不再写入会话', async () => {
    const core = createCoreInstance({ registerTools: registerStandardTools })
    const id = 'stale-project-skills'
    core.rootStore.setter(workspacesAtom, {
      ws1: { id: 'ws1', name: 'workspace', rootPath: '/workspace', createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        workspaceId: 'ws1',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let releaseSkillScan!: () => void
    const skillScan = new Promise<void>((resolve) => {
      releaseSkillScan = resolve
    })
    const ensureSpy = vi.spyOn(core.projectSkills, 'ensure').mockImplementation(async (workspaceRoot) => {
      await skillScan
      return { workspaceRoot, entries: [], diagnostics: [] }
    })
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      return jsonResponse('不该请求')
    }
    const store = core.getSessionStore(id).store

    const oldRun = runSession(id, '旧请求', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })
    await waitUntil(() => ensureSpy.mock.calls.length === 1, 'project skills scan')
    const itemsBeforeReplacement = clone(store.getter(itemsAtom))
    const checkpointsBeforeReplacement = clone(store.getter(checkpointsAtom))
    const eventsBeforeReplacement = clone(store.getter(runtimeTranscriptEventsAtom))

    setRun(id, { runId: 'replacement-run', status: 'running', loadedTools: ['replacement-tool'] }, core)
    releaseSkillScan()
    await oldRun

    expect(requestCount).toBe(0)
    expect(store.getter(runAtom)).toMatchObject({
      runId: 'replacement-run',
      status: 'running',
      loadedTools: ['replacement-tool'],
    })
    expect(store.getter(itemsAtom)).toEqual(itemsBeforeReplacement)
    expect(store.getter(checkpointsAtom)).toEqual(checkpointsBeforeReplacement)
    expect(store.getter(runtimeTranscriptEventsAtom)).toEqual(eventsBeforeReplacement)
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
    // stopped 轮仍形成可撤回 checkpoint，但不写回迟到的 assistant。
    const checkpoints = getSessionStore('s1').store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].items.map((it) => it.item.role)).toEqual(['user', 'tool'])
    expect(checkpoints[0]).toMatchObject({ label: '[已停止] hi', kind: 'stopped' })
  })
})

describe('runSession（多轮 lazy-tool 循环，T-6）', () => {
  it('无业务工具单轮：保留 sessionStart 清单后完成（done、checkpoint 长 1）', async () => {
    seedSession('t0', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('直接答')

    await runSession('t0', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t0').store
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(items[2].item).toEqual({ role: 'assistant', content: '直接答' })
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
    expect(during.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(during[2]).toMatchObject({ id: assistantId, pending: true, item: { role: 'assistant', content: '你' } })

    controller!.enqueue(encoder.encode(sseBlock({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] })))
    controller!.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller!.close()
    await runPromise

    const done = getSessionStore('stream-text').store.getter(itemsAtom)
    expect(done).toHaveLength(3)
    expect(done[2]).toMatchObject({ id: assistantId, pending: false, item: { role: 'assistant', content: '你好' } })
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
    expect(during[2]).toMatchObject({
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
    expect(done).toHaveLength(3)
    expect(done[2]).toMatchObject({
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])
    const asstTc = items[2].item
    const toolItem = items[3].item
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
    // user → timed 清单 → assistant(tool_calls) → tool(schema) → assistant(final)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])

    const asstTc = items[2].item
    const toolItem = items[3].item
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
    expect((items[4].item as { content?: string }).content).toBe('最终答案')
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

  it('应用重启后的新 run 从 SessionMeta 恢复已加载 schema，无需 loader 历史或旧 run', async () => {
    seedSession('schema-restart', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      'schema-restart': {
        ...sessions['schema-restart'],
        loadedTools: ['skill_search'],
      },
    }))
    const store = getSessionStore('schema-restart').store
    store.setter(itemsAtom, [
      { id: 'user-after-restart', createdAt: 1, item: { role: 'user', content: '继续搜索' } },
    ])
    setRun('schema-restart', { runId: 'new-process-run', status: 'running' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(init!.body as string) as Record<string, unknown>
      return jsonResponse('已从持久化工具缓存继续')
    }

    await runToolLoop('schema-restart', 'new-process-run', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const sentTools = captured.tools as ModelFunctionTool[]
    expect(sentTools.map((tool) => tool.function.name)).toContain('skill_search')
    expect(sentTools.find((tool) => tool.function.name === 'skill_search')?.function.parameters)
      .toEqual(toolRegistry.loadSchema('skill_search')?.inputSchema)
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
    // user → timed 清单 → asst(tc schema) → tool(schema) → asst(tc skill_search) → tool(results) → asst(final)
    expect(items.map((it) => it.item.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const searchResult = items[5].item
    if (searchResult.role !== 'tool') throw new Error('意外的条目形状')
    expect(searchResult.content.includes('results')).toBe(true)
    expect(getSessionStore('t2').store.getter(runAtom)?.status).toBe('done')
  })

  // 稳定前缀里的工具摘要给了模型精确名字，它于是常常跳过 request_tool_schema 直接调用。
  // 这次调用本身已经说清了「要哪个工具」＝ request_tool_schema 唯一要问的事，所以闸门把它
  // 当作一次加载请求走同一条 lazy 通道，而不是回一条纯拒绝让模型白烧一轮再问一遍。
  it('直接调用未加载工具：本次不执行，但就地加载 schema，下一轮起随 tools 长期携带', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('lazy-autoload', { vendor: 'deepseek', model: 'x' })
    const exposedPerRequest: string[][] = []
    const responses: Array<() => Response> = [
      // 首轮 tools 里只有 request_tool_schema；模型凭工具摘要猜了名字（参数还猜错了）。
      () => toolCallsResponse([{ name: 'skill_search', args: { skillName: 'planning' }, id: 'guessed' }]),
      // 关键断言点：模型【不需要】再单发一次 request_tool_schema，直接按真 schema 重发即可。
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'planning' }, id: 'search' }]),
      () => jsonResponse('已完成'),
    ]
    let index = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { tools: ModelFunctionTool[] }
      exposedPerRequest.push(body.tools.map((tool) => tool.function.name))
      const maker = responses[Math.min(index, responses.length - 1)]
      index += 1
      return maker()
    }

    await runSession('lazy-autoload', '规划任务', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    // 三次请求就收工（旧行为要四次：猜调被拒 → request_tool_schema → 真调用 → 收尾）。
    expect(exposedPerRequest).toHaveLength(3)
    expect(exposedPerRequest[0]).toEqual(['request_tool_schema'])
    expect(exposedPerRequest[1]).toContain('skill_search')
    // 「加载后永久携带」：后续每一轮都还在 tools 里。
    expect(exposedPerRequest[2]).toContain('skill_search')

    const items = getSessionStore('lazy-autoload').store.getter(itemsAtom)
    const autoloaded = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'guessed',
    )?.item
    if (!autoloaded || autoloaded.role !== 'tool') throw new Error('缺少加载结果')
    const payload = JSON.parse(autoloaded.content) as Record<string, unknown>
    expect(payload.code).toBe('tool_schema_autoloaded')
    expect(payload.loaded).toBe(true)
    // 【不执行】：猜出来的 skillName 没有落地成一次真实搜索，结果里只有加载确认与 guide。
    expect(payload.executed).toBe(false)
    expect(payload).not.toHaveProperty('results')
    expect(Object.keys(payload).sort()).toEqual(
      ['code', 'executed', 'guide', 'hint', 'loaded', 'toolName'],
    )
    // 【inputSchema 不进消息历史】：完整 schema 只经顶层 tools 下发。
    expect(autoloaded.content).not.toContain('inputSchema')

    const searchResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'search',
    )?.item
    if (!searchResult || searchResult.role !== 'tool') throw new Error('缺少搜索结果')
    expect(searchResult.content).toContain('results')

    expect(trace.events.some((event) =>
      event.name === 'tool.schema_autoloaded' && event.attrs?.toolName === 'skill_search'
    )).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.schema_not_loaded')).toBe(false)
    expect(getSessionStore('lazy-autoload').store.getter(runAtom)?.status).toBe('done')
  })

  it('未注册的幻觉工具名仍然硬拒绝，不会被当作加载请求', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('lazy-ghost', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'totally_unknown_tool', args: { x: 1 }, id: 'ghost' }]),
      () => jsonResponse('收到'),
    ])

    await runSession('lazy-ghost', '干点什么', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const items = getSessionStore('lazy-ghost').store.getter(itemsAtom)
    const ghostResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'ghost',
    )?.item
    if (!ghostResult || ghostResult.role !== 'tool') throw new Error('缺少未加载工具结果')
    expect(ghostResult.content).toContain('tool_schema_not_loaded')
    expect(ghostResult.content).toContain('request_tool_schema')
    expect(trace.events.some((event) =>
      event.name === 'tool.schema_not_loaded' && event.attrs?.toolName === 'totally_unknown_tool'
    )).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.schema_autoloaded')).toBe(false)
  })

  it('TP3：web 下直接调用 server 工具仍然硬拒绝，不会被加载进 tools', async () => {
    // 该工具在 web 下既不进工具摘要也不进 tools，模型调它就是真的调了一个当前环境不存在的能力。
    tauriControl.enabled = false
    seedSession('lazy-server-tool', { vendor: 'deepseek', model: 'x' })
    const exposedPerRequest: string[][] = []
    const responses: Array<() => Response> = [
      () => toolCallsResponse([{ name: 'shell_macos', args: { command: 'ls' }, id: 'server-call' }]),
      () => jsonResponse('收到'),
    ]
    let index = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { tools: ModelFunctionTool[] }
      exposedPerRequest.push(body.tools.map((tool) => tool.function.name))
      const maker = responses[Math.min(index, responses.length - 1)]
      index += 1
      return maker()
    }

    await runSession('lazy-server-tool', '跑个命令', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = getSessionStore('lazy-server-tool').store.getter(itemsAtom)
    const rejected = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'server-call',
    )?.item
    if (!rejected || rejected.role !== 'tool') throw new Error('缺少拒绝结果')
    expect(rejected.content).toContain('tool_schema_not_loaded')
    expect(exposedPerRequest[1]).not.toContain('shell_macos')
  })

  it('observability：driver 启用时成功工具轮保留脱敏 payload shape 和可读 preview', async () => {
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
    expect(llmSpans[0]?.attrs?.adapter_retry_attempt).toBe(0)
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
      result: { redacted: true, kind: 'object', keys: 5 },
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])
    // 暂停状态和未闭合 ask tool_call 一起覆盖进同一工作 checkpoint，刷新后卡片仍可回答。
    const checkpoints = getSessionStore('t3').store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      label: 'hi',
      kind: 'working',
      recovery: {
        run: {
          status: 'waiting_user',
          pendingQuestion: payload,
        },
      },
    })
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
    defaultCore.planRuntime = ((store: PlanRuntimeStore) => ({
      get: store.get,
      create: (input: CreatePlanInput) => {
        const now = Date.now()
        const plan = {
          schemaVersion: 4 as const, id: 'plan-wait', title: input.title, objective: input.objective,
          status: 'awaiting_approval' as const, revision: 1, requiresApproval: true, createdAt: now, updatedAt: now,
          stages: input.stages.map((stage) => ({ ...stage, deliverables: stage.deliverables ?? [], dependencies: stage.dependencies ?? [], status: 'pending' as const, evidence: [] })),
        }
        store.set(plan)
        return { ok: true as const, plan }
      },
    })) as unknown as PlanRuntimeFactory
    seedSession('plan-wait', { vendor: 'deepseek', model: 'x' })
    const args = {
      title: '实现功能', objective: '完成实现与验证', approvalMode: 'required',
      stages: [{ id: 'build', title: '实现', objective: '写代码' }],
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
      'user', 'tool', 'assistant', 'tool', 'assistant',
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
      'user', 'tool', 'assistant', 'tool', 'assistant', 'tool',
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

  it('普通运行：模型不停请求 schema → 666 轮后 error，但整轮仍落 checkpoint', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('t4', { vendor: 'deepseek', model: 'x' })
    let count = 0
    let checkpointCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      if (JSON.stringify(body.messages).includes('Create the durable context checkpoint now. Return only the checkpoint text.')) {
        checkpointCalls += 1
        return jsonResponse('继续请求工具 schema。')
      }
      count += 1
      return toolCallsResponse([
        { name: 'request_tool_schema', args: { toolName: 'skill_search', reason: `loop-${count}` } },
      ])
    }

    await runSession('t4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t4').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toBe('主 Agent 超过最大模型轮次（666）')
    // 恰好跑满主 Agent 上限；子 Agent 使用独立循环与预算，不计入这里。
    expect(count).toBe(666)
    expect(checkpointCalls).toBeGreaterThan(0)
    // ★ 回归：跑满 666 轮时 itemsAtom 里已堆了大量 assistant/tool 条目，整轮不落盘代价最大 ——
    //   刷新后连用户那条 user 消息都没了。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(persistence.saved.length).toBeGreaterThan(1)
    expect(persistence.saved.at(-1)?.checkpoint.items[0].item).toEqual({ role: 'user', content: 'hi' })
    // 666 轮在全量并发下会明显放大 worker 竞争，保留足够余量避免误判超时。
  }, 30_000)

  it('计划运行：按阶段数放大主 Agent 轮次预算，且不计入子 Agent 轮次', async () => {
    seedSession('plan-turn-limit', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-turn-limit').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 4,
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
        dependencies: [],
        status: 'pending',
        evidence: [],
      }],
    })
    let count = 0
    let checkpointCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      if (JSON.stringify(body.messages).includes('Create the durable context checkpoint now. Return only the checkpoint text.')) {
        checkpointCalls += 1
        return jsonResponse('当前计划仍在执行；继续请求工具 schema。')
      }
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

    expect(count).toBe(501)
    expect(checkpointCalls).toBeGreaterThan(0)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'error',
      error: '主 Agent 超过最大模型轮次（501）',
    })
    // 501 轮循环单跑约 6 秒，全量并发时会超过默认 5 秒——与上面 666 轮用例同一理由给显式预算。
  }, 15_000)

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
      schemaVersion: 4,
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
      expect(body.messages.some((message) => message.content?.includes('<current_plan_definition>'))).toBe(true)
      expect(body.messages.some((message) => message.content?.includes('<current_plan_state>'))).toBe(true)
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

  it('计划仍在执行时，文本总结只算阶段说明并继续运行，不能提前结束', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('plan-premature-final', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-premature-final').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 4,
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
          content: expect.stringContaining('<current_plan_state>'),
        })
        expect(body.messages.at(-1)?.content).toContain('"planId":"plan-premature"')
        expect(body.messages.at(-1)?.content).toContain('"revision":1')
        expect(body.messages.at(-1)?.content).toContain('"currentStageId":"stage-current"')
        expect(body.messages.at(-2)?.content).toContain('<current_plan_definition>')
        expect(body.messages.at(-2)?.content).toContain('"stageId":"stage-current"')
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
      label: '执行完整计划',
      kind: 'working',
    })
    expect(persistence.saved.some(({ checkpoint }) =>
      checkpoint.items.some((item) =>
        item.planStageId === 'stage-current'
        && item.item.role === 'assistant'
        && item.item.content === '总结：整个任务已完成'
      )
    )).toBe(true)
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
      schemaVersion: 4,
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
      schemaVersion: 4,
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
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    // submit_stage_result 未在本轮 tools 暴露（懒加载）→ 闸门把这次调用转成一次 schema 加载、
    // 本次提交不执行。阶段仍未关闭，因此「这次没落地」必须作为拒绝原因进续跑提醒，
    // 否则模型会以为已经提交过了。
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
    expect(injected).toContain('本次调用未执行')
    expect(injected).toContain('schema 此前未加载')
  })

  it('单个阶段连续占用超过阈值轮次仍不推进时，阶段进度 guard 硬暂停', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('plan-stage-guard', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-stage-guard').store
    const now = Date.now()
    // 3 阶段计划：总预算为每阶段 500 次加 guard 入口的余量；单阶段 guard
    // 在第 501 次循环先于总预算触发，确保用户得到可行动的阶段诊断。
    store.setter(planAtom, {
      schemaVersion: 4,
      id: 'plan-stage-guard-plan',
      title: '多阶段计划',
      objective: '验证阶段进度 guard',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        { id: 'stage-1', title: '阶段一', objective: 'x', deliverables: [], dependencies: [], status: 'in_progress', evidence: [] },
        { id: 'stage-2', title: '阶段二', objective: 'x', deliverables: [], dependencies: [], status: 'pending', evidence: [] },
        { id: 'stage-3', title: '阶段三', objective: 'x', deliverables: [], dependencies: [], status: 'pending', evidence: [] },
      ],
    })
    let count = 0
    let checkpointCalls = 0
    // 每轮都调工具（不走纯文本），避免撞上 stall guard；始终停留在 stage-1，不推进。
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      if (JSON.stringify(body.messages).includes('Create the durable context checkpoint now. Return only the checkpoint text.')) {
        checkpointCalls += 1
        return jsonResponse('阶段一尚未完成，继续请求工具 schema。')
      }
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

    // guard 在第 501 轮开头触发（stageTurnsOnGuard 501>500），此前已发起 500 次请求。
    expect(count).toBe(500)
    expect(checkpointCalls).toBeGreaterThan(0)
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('已连续占用超过 500 轮')
    expect(trace.events.some((event) => event.name === 'agent.plan_stage_over_budget')).toBe(true)
    // 500 轮循环单跑约 6 秒，全量并发时会超过默认 5 秒——与 666 轮用例同一理由给显式预算。
  }, 15_000)

  it('阶段进度 guard 跨恢复沿用持久化模型轮数，不因新 run 清零', async () => {
    seedSession('plan-stage-persisted-guard', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('plan-stage-persisted-guard').store
    const now = Date.now()
    store.setter(planAtom, {
      schemaVersion: 4,
      id: 'plan-stage-persisted-guard-plan',
      title: '跨恢复阶段保护',
      objective: '同一阶段不能无限恢复',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        { id: 'stage-1', title: '阶段一', objective: 'x', deliverables: [], dependencies: [], status: 'in_progress', evidence: [] },
        { id: 'stage-2', title: '阶段二', objective: 'x', deliverables: [], dependencies: ['stage-1'], status: 'pending', evidence: [] },
      ],
    })
    store.setter(itemsAtom, [
      { id: 'user-1', createdAt: 1, item: { role: 'user', content: '执行计划' } },
      ...Array.from({ length: 500 }, (_, index) => ({
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
      error: expect.stringContaining('已连续占用超过 500 轮'),
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
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual(['user', 'tool'])
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0]).toMatchObject({ label: '[已停止] 继续执行', kind: 'stopped' })
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
      'tool',
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
      'tool',
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
    const checkpoints = getSessionStore('t5').store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool'])
    expect(checkpoints[0]).toMatchObject({ label: '[已停止] hi', kind: 'stopped' })
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
      'user', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant',
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(false)
    // 确认状态和未执行的危险 tool_call 一起覆盖进工作 checkpoint，刷新后仍由用户决定。
    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      label: 'hi',
      kind: 'working',
      recovery: {
        run: {
          status: 'waiting_confirmation',
          pendingToolConfirmation: {
            callId: 'w1',
            toolName: 'write_file',
            args,
          },
        },
      },
    })
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
    expect(JSON.parse(result.content)).toMatchObject({
      details: { reversible: false },
    })
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
      'user', 'tool', 'assistant', 'tool', 'assistant', 'tool',
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
    // sessionStart 清单先于确认恢复工具执行：user → assistant(tool_calls) → timed 清单 → tool(w1 的 result) → assistant(final)。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant'])
    const toolItem = items[3].item
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
      config: { modelCredentials: { deepseek: 'k' }, fetchImpl },
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
  it('重启中断恢复：沿用原 run/checkpoint，孤儿写工具按 unknown 闭合且不自动重放', async () => {
    seedSession('restart-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('restart-resume').store
    const interruptedItems = [
      { id: 'u1', createdAt: 1, item: { role: 'user' as const, content: '修改文件' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'write-1',
            type: 'function' as const,
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.txt', content: 'new' }),
            },
          }],
        },
      },
    ]
    store.setter(itemsAtom, interruptedItems)
    store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: '[执行中] 修改文件',
      createdAt: 3,
      items: interruptedItems,
      recovery: {
        run: {
          runId: 'original-run',
          turnId: 'u1',
          status: 'interrupted',
        },
      },
    }])
    setRun('restart-resume', {
      runId: 'original-run',
      turnId: 'u1',
      status: 'interrupted',
    })
    let requestMessages: Array<{ role: string; tool_call_id?: string; content?: string }> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: typeof requestMessages }
      requestMessages = body.messages
      return jsonResponse('已检查并继续完成')
    }

    await resumeInterruptedSession('restart-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(store.getter(runAtom)).toMatchObject({
      runId: 'original-run',
      turnId: 'u1',
      status: 'done',
    })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ])
    const interruptedToolResult = store.getter(itemsAtom)[2].item
    if (interruptedToolResult.role !== 'tool') throw new Error('意外的条目形状')
    expect(interruptedToolResult.tool_call_id).toBe('write-1')
    expect(JSON.parse(interruptedToolResult.content)).toMatchObject({
      interrupted: true,
      result: 'unknown',
    })
    expect(requestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'write-1',
        content: expect.stringContaining('"interrupted":true'),
      }),
    ]))
    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      turnIndex: 0,
      label: '修改文件',
      kind: 'completed',
      recovery: undefined,
    })
  })

  it('恢复已有 sessionStart skills 清单时不重复 ensure 或写入 timed item', async () => {
    const workspaceRoot = '/workspace/resumed-skills'
    const projectSkillsProvider = vi.fn(async () => ({ workspaceRoot, entries: [], diagnostics: [] }))
    const core = createCoreInstance({ registerTools: registerStandardTools, projectSkillsProvider })
    const id = 'resume-existing-skill-manifest'
    core.rootStore.setter(workspacesAtom, {
      workspace: { id: 'workspace', name: '恢复工作区', rootPath: workspaceRoot, createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        workspaceId: 'workspace',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user' as const, content: '继续执行' } },
      {
        id: 'existing-skill-manifest',
        createdAt: 2,
        item: {
          role: 'tool' as const,
          tool_call_id: 'timed:sessionStart:skill_manifest',
          content: JSON.stringify('可用 skills：\n· planning — 何时用：任务跨多个阶段/模块'),
        },
      },
    ])
    setRun(id, { runId: 'interrupted-run', turnId: 'user', status: 'interrupted' }, core)
    let requestMessages: Array<{ role: string; tool_call_id?: string; content?: string }> = []

    await resumeInterruptedSession(id, {
      signal: new AbortController().signal,
      apiKey: 'k',
      core,
      fetchImpl: async (_url, init) => {
        requestMessages = (JSON.parse(String(init?.body)) as { messages: typeof requestMessages }).messages
        return jsonResponse('已恢复')
      },
    })

    expect(projectSkillsProvider).not.toHaveBeenCalled()
    expect(store.getter(itemsAtom).filter(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'timed:sessionStart:skill_manifest',
    )).toHaveLength(1)
    expect(requestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'timed:sessionStart:skill_manifest',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'timed:sessionStart:skill_manifest',
      }),
    ]))
  })

  it('新旧工作 checkpoint 共存时，结构化最新记录续跑且不误改旧前缀记录', async () => {
    seedSession('mixed-checkpoint-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('mixed-checkpoint-resume').store
    const legacyItems = [
      { id: 'legacy-user', createdAt: 1, item: { role: 'user' as const, content: '旧任务' } },
    ]
    const currentItems = [
      { id: 'current-user', createdAt: 2, item: { role: 'user' as const, content: '新任务' } },
    ]
    store.setter(itemsAtom, currentItems)
    store.setter(checkpointsAtom, [
      {
        turnIndex: 0,
        label: '[执行中] 旧任务',
        createdAt: 1,
        items: legacyItems,
        recovery: {
          run: { runId: 'legacy-run', turnId: 'legacy-user', status: 'interrupted' },
        },
      },
      {
        turnIndex: 1,
        label: '新任务',
        kind: 'working',
        createdAt: 2,
        items: currentItems,
        recovery: {
          run: { runId: 'structured-run', turnId: 'current-user', status: 'interrupted' },
        },
      },
    ])
    setRun('mixed-checkpoint-resume', {
      runId: 'structured-run',
      turnId: 'current-user',
      status: 'interrupted',
    })

    await resumeInterruptedSession('mixed-checkpoint-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse('新任务已完成'),
    })

    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]).toMatchObject({
      label: '[执行中] 旧任务',
      recovery: { run: { runId: 'legacy-run' } },
    })
    expect(checkpoints[0]).not.toHaveProperty('kind')
    expect(checkpoints[1]).toMatchObject({
      turnIndex: 1,
      label: '新任务',
      kind: 'completed',
      recovery: undefined,
    })
    expect(store.getter(runAtom)).toMatchObject({ runId: 'structured-run', status: 'done' })
  })

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
    // 复用已有 user；sessionStart 清单后才 append 最终 assistant。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(items[2].item).toEqual({ role: 'assistant', content: '答案' })
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    const assistantItem = items[2].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('半截答案')
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
    // ★ 回归（MAJOR）：itemsAtom 不持久化，落盘的唯一入口就是 commitCheckpoint + persistCheckpoint。
    //   这一轮若不落盘，用户刷新后不只半截答案没了，连他自己发的那条 user 消息也一起消失。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0].items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(persistence.saved).toHaveLength(3)
    expect(persistence.saved.at(-1)?.sessionId).toBe('fr1')
    expect(persistence.saved.at(-1)?.checkpoint.items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    // ★ 回归（MAJOR）：finishPending() 只写 { pending:false }、从不写 content，
    //   末尾那段文字只活在 streamWriter 闭包里 —— 界面会比实际收到的还少一截且毫无提示。
    const streamedItem = items[2].item
    if (streamedItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(streamedItem.content).toContain('前半段后半段')
    // 系统标注只能【追加】在完整正文之后，不能把流式对账出来的文本顶掉。
    expect(streamedItem.content?.startsWith('前半段后半段')).toBe(true)
    expect(items[2].pending).toBe(false)
    // 半截 assistant 条目绝不能带 tool_calls：本分支要 return、不执行工具，
    // 落下 tool_calls 就成了没有 result 的孤儿，下一轮重发直接被接口判非法。
    expect('tool_calls' in items[2].item).toBe(false)
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    const assistantItem = items[2].item
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

  it('容量响应抵达时已 abort：adapter 守卫不得发送第二个请求', async () => {
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

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-abort').store.getter(runAtom)?.status).toBe('stopped')
  })

  it('容量响应抵达后 run 已过期：adapter 守卫不得为新 run 重试', async () => {
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

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-stale').store.getter(runAtom)).toMatchObject({
      runId: 'NEW-RUN',
      status: 'running',
    })
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
    //   同时把异常状态写进结构化字段——否则刷新后聊天区看起来这轮什么都没发生。
    const checkpoint = store.getter(checkpointsAtom)[0]
    expect(checkpoint).toMatchObject({ label: '敏感问题', kind: 'abnormal', finishReason: 'content_filter' })
    const committedAssistant = checkpoint.items[2].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('content_filter')
    expect(persistence.saved).toHaveLength(3)
    const savedAssistant = persistence.saved.at(-1)!.checkpoint.items[2].item
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
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])
    const toolItem = items[3].item
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

  it('截断标记进持久化：正文带系统标注 + checkpoint 结构化状态，且重发给模型时仍看得见', async () => {
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
    expect(checkpoint).toMatchObject({ label: '算个数', kind: 'abnormal', finishReason: 'length' })
    const committedAssistant = checkpoint.items[2].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('第一步先算出 42')
    expect(String(committedAssistant.content)).toContain('finish_reason=length')
    // 落盘的那一份（刷新后唯一的真相源）必须同样带着标注与结构化状态。
    expect(persistence.saved).toHaveLength(3)
    expect(persistence.saved.at(-1)?.checkpoint).toMatchObject({
      label: '算个数',
      kind: 'abnormal',
      finishReason: 'length',
    })
    const savedAssistant = persistence.saved.at(-1)!.checkpoint.items[2].item
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
    expect(store.getter(itemsAtom)[2].item).toEqual({ role: 'assistant', content: '完整答案' })
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
    installDefaultDelegationForDisposeTest()
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
    expect(disposeEvent?.spanId).toBeUndefined()
  })

  it('dispose 抛 AbortError：同样不逃逸，stopped 结局不被改写', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // 走到 finally 时本轮结局早已判完（这里是 stopped）。把 dispose 的 AbortError 再抛出去，
    // 只会把一个已经收好的 run 变成 reject —— 没有任何人会再消费它。
    const abortErr = new Error('The operation was aborted.')
    abortErr.name = 'AbortError'
    disposeControl.error = abortErr
    installDefaultDelegationForDisposeTest()
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
    const toolItem = items[3].item
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
    const toolItem = getSessionStore('pa2').store.getter(itemsAtom)[3].item
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
// 上下文 checkpoint 接入
// ---------------------------------------------------------------------------
describe('上下文 checkpoint 接入', () => {
  it('未超预算：请求体就是原始 messages，不产生摘要事件', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('cc0', { vendor: 'deepseek', model: 'deepseek-v4-flash' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('好'))
    }

    await runSession('cc0', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    // 固定 system + 工具摘要 + 运行环境 + user + timed 清单配对，共六条。
    expect((captured.messages as unknown[]).length).toBe(6)
    expect(trace.events.some((event) => event.name === 'llm.context_distillation_started')).toBe(false)
    expect(trace.events.some((event) => event.name === 'llm.context_distillation_succeeded')).toBe(false)
  })

  it('超预算时先生成模型 checkpoint，后续正常请求只发送它和增量历史', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('cc1', { vendor: 'deepseek', model: 'x', max_tokens: 48_000 })
    const store = getSessionStore('cc1').store
    const bigResult = JSON.stringify({ data: 'x'.repeat(50_000) })
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
    const requests: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      requests.push(body)
      if (JSON.stringify(body.messages).includes('Create the durable context checkpoint now. Return only the checkpoint text.')) {
        return Promise.resolve(jsonResponse('已读取第一轮工具结果，继续处理第二轮请求。'))
      }
      return Promise.resolve(jsonResponse('好'))
    }

    await runToolLoop('cc1', 'CC1', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    expect(requests).toHaveLength(2)
    const [distillationRequest, normalRequest] = requests
    expect((distillationRequest.messages as Array<Record<string, unknown>>).some(
      (message) => message.role === 'tool' && message.content === bigResult,
    )).toBe(true)
    const normalMessages = JSON.stringify(normalRequest.messages)
    expect(normalMessages).toContain('Runtime context checkpoint')
    expect(normalMessages).toContain('已读取第一轮工具结果')
    expect(normalMessages).not.toContain(bigResult)
    expect(normalMessages).not.toContain('_compacted')

    const items = store.getter(itemsAtom)
    const storedTool = items[2].item
    if (storedTool.role !== 'tool') throw new Error('意外的条目形状')
    expect(storedTool.content).toBe(bigResult)
    expect(store.getter(contextCheckpointAtom)).toMatchObject({
      schemaVersion: 1,
      summary: '已读取第一轮工具结果，继续处理第二轮请求。',
    })
    expect(store.getter(contextCheckpointAtom)?.coveredItemIds).toEqual(expect.arrayContaining([
      'u1', 'a1', 't1', 'a2', 'u2',
    ]))
    expect(store.getter(contextCheckpointAtom)?.coveredItemIds).toHaveLength(6)
    expect(store.getter(contextStatsAtom)?.messagesCount).toBe(
      (normalRequest.messages as unknown[]).length,
    )
    expect(trace.events.filter((event) => event.name === 'llm.context_distillation_started')).toHaveLength(1)
    expect(trace.events.filter((event) => event.name === 'llm.context_distillation_succeeded')).toHaveLength(1)
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('模型摘要事件恰好各发一遍且带 baseTraceAttrs', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('cc5', { vendor: 'deepseek', model: 'x', max_tokens: 48_000 })
    const store = getSessionStore('cc5').store
    const bigResult = JSON.stringify({ data: 'z'.repeat(50_000) })
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
    const fetchImpl: typeof fetch = (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      return Promise.resolve(
        JSON.stringify(body.messages).includes('Create the durable context checkpoint now. Return only the checkpoint text.')
          ? jsonResponse('已完成第一轮分析。')
          : jsonResponse('好'),
      )
    }

    await runToolLoop('cc5', 'CC5', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const startedEvents = trace.events.filter((event) => event.name === 'llm.context_distillation_started')
    const succeededEvents = trace.events.filter((event) => event.name === 'llm.context_distillation_succeeded')
    expect(startedEvents).toHaveLength(1)
    expect(succeededEvents).toHaveLength(1)
    for (const event of [startedEvents[0], succeededEvents[0]]) {
      expect(event?.attrs?.sessionId).toBe('cc5')
      expect(event?.attrs?.runId).toBe('CC5')
      expect(event?.attrs?.turnId).toBe('u2')
    }
  })

  it('摘要直接采用模型的文本回复，不要求结构化格式', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('cc4', { vendor: 'deepseek', model: 'x', max_tokens: 48_000 })
    const store = getSessionStore('cc4').store
    const bigResult = JSON.stringify({ data: 'y'.repeat(50_000) })
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
    let requests = 0
    const fetchImpl: typeof fetch = () => {
      requests += 1
      return Promise.resolve(jsonResponse('not JSON'))
    }

    await runToolLoop('cc4', 'CC4', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    expect(requests).toBe(2)
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(contextCheckpointAtom)).toMatchObject({ summary: 'not JSON' })
    expect(store.getter(itemsAtom)[2]?.item).toMatchObject({ content: bigResult })
    expect(trace.events.filter((event) => event.name === 'llm.context_distillation_succeeded')).toHaveLength(1)
    expect(trace.events.filter((event) => event.name === 'llm.context_distillation_failed')).toHaveLength(0)
  })
  // 请求路径兜底：seedSession 直接写 sessionsAtom、【不经 hydrate】—— 正是「绕过 hydrate 迁移」
  // 的场景。会话带着已下线的 deepseek-chat / deepseek-reasoner，发出去的主 Agent 请求必须
  // 迁移到 Flash，且 deepseek-reasoner 要连带把 thinking 补成 enabled（旧名隐含思考模式）。
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

    it('deepseek-chat → v4-flash 且 thinking 显式 disabled（保留旧非思考行为）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-chat' })
      expect(body.model).toBe('deepseek-v4-flash')
      // 旧 deepseek-chat = 非思考模式；迁移后仍保留旧名隐含的模式语义。
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it('deepseek-reasoner → v4-flash 且 thinking 补成 enabled（旧名隐含思考模式）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-reasoner' })
      expect(body.model).toBe('deepseek-v4-flash')
      expect(body.thinking).toEqual({ type: 'enabled' })
    })

    it('用户显式关了 thinking → 迁移不覆盖他的选择（thinking 优先于旧名隐含语义）', async () => {
      const body = await capturedRequestFor({
        vendor: 'deepseek',
        model: 'deepseek-reasoner',
        thinking: false,
      })
      expect(body.model).toBe('deepseek-v4-flash')
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])(
      '未下线的模型名 %s 原样发出（不覆盖用户已保存的选择）',
      async (model) => {
        const body = await capturedRequestFor({ vendor: 'deepseek', model })
        expect(body.model).toBe(model)
      },
    )
  })
})

// ---------------------------------------------------------------------------
// 工具连败软提醒
// ---------------------------------------------------------------------------
// 同一工具在一次 run 内失败达 TOOL_FAILURE_STREAK_THRESHOLD（现为 1，即每次失败）→ 下一轮请求
// 临时注入一条 system 提醒（只进请求投影，不写 itemsAtom）。它只提醒「先按错误提示自救」，
// 不终止 run —— 熔断职责仍在 loopGuard / max_turns。
// streak 计数仍按【连续】失败累计：只影响列表行文案（1 次「调用失败」／N 次「已连续失败 N 次」），
// 不影响是否注入。
// ★ 用例里同一工具的参数逐次变化 ★：同签名跨轮重复 3 次会先命中循环检测（阈值 3）而整轮 error，
//   那是另一条链路；这里要测的是「失败但每次都换参数」的软提醒。
describe('工具连败软提醒', () => {
  // 新文案的稳定锚点（指令句尾部），与 selfReflectionPrompts.toolFailureStreakNotice 对齐。
  const NOTICE_MARK = '不要原样重发同一调用'

  // 可控成败的测试工具：calls 从 1 开始计数，达到 succeedFrom 之后返回成功。
  function registerFlakyTool(
    name: string,
    error: string,
    options?: { parallel?: boolean },
  ): { calls: number; succeedFrom: number } {
    const state = { calls: 0, succeedFrom: Number.POSITIVE_INFINITY }
    toolRegistry.register({
      name,
      runtime: 'internal',
      ...(options?.parallel ? { execution: { mode: 'parallel' as const, effectKeys: ['test:read'] } } : {}),
      skill: { description: 'x', content: 'x' },
      inputSchema: { type: 'object' },
      execute() {
        state.calls += 1
        return state.calls >= state.succeedFrom
          ? { ok: true, data: { done: true } }
          : { ok: false, error }
      },
    })
    return state
  }

  // 每次请求体里的 system 文本 —— 提醒只存在于请求投影，断言只能从这里取。
  function captureSystemTexts(responses: Array<() => Response>): {
    fetchImpl: typeof fetch
    systemTexts: string[]
  } {
    const systemTexts: string[] = []
    let i = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content?: unknown }>
      }
      systemTexts.push(
        body.messages
          .filter((message) => message.role === 'system')
          .map((message) => String(message.content ?? ''))
          .join('\n'),
      )
      const maker = responses[Math.min(i, responses.length - 1)]
      i += 1
      return maker()
    }
    return { fetchImpl, systemTexts }
  }

  function loadToolCall(toolName: string, id: string): Response {
    return toolCallsResponse([{
      name: 'request_tool_schema',
      args: { toolName, reason: `加载 ${toolName}` },
      id,
    }])
  }

  it('失败 1 次 → 下一轮即注入；继续失败则列表行升为「已连续失败 N 次」', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    registerFlakyTool('__streak_fail_a__', 'ENOENT: 目标路径不存在')
    seedSession('streak-a', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_a__', 'load-a'),
      () => toolCallsResponse([{ name: '__streak_fail_a__', args: { attempt: 1 }, id: 'fail-a1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_a__', args: { attempt: 2 }, id: 'fail-a2' }]),
      () => jsonResponse('这条路走不通，我说明一下阻塞原因'),
    ])

    await runSession('streak-a', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    // 4 次请求：加载 schema / 第 1 次失败 / 带 count=1 提醒的那一轮 / 带 count=2 提醒的那一轮。
    expect(systemTexts).toHaveLength(4)
    // 第 1 次失败之后的那一轮就要收到提醒（阈值 1：不再等第二败）。
    expect(systemTexts[2]).toContain('· __streak_fail_a__：调用失败；错误：ENOENT: 目标路径不存在')
    expect(systemTexts[2]).not.toContain('已连续失败')
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    // 同一工具再败一次 → 列表行切到多次分支，仍然每轮都提醒。
    expect(systemTexts[3]).toContain('· __streak_fail_a__：已连续失败 2 次；最近一次错误：ENOENT: 目标路径不存在')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 提醒不熔断：run 仍照常收在最终答案上。
    expect(getSessionStore('streak-a').store.getter(runAtom)?.status).toBe('done')
    const events = trace.events.filter((e) => e.name === 'agent.tool_failure_notice')
    expect(events).toHaveLength(2)
    expect(events[0]?.attrs?.tools).toEqual([{ name: '__streak_fail_a__', count: 1 }])
    expect(events[1]?.attrs?.tools).toEqual([{ name: '__streak_fail_a__', count: 2 }])
  })

  it('只失败 1 次也注入，且那条提醒只发一轮（一次性消费）', async () => {
    registerFlakyTool('__streak_fail_b__', 'EPERM: 权限不足')
    const helper = registerFlakyTool('__streak_ok_b__', '不会走到这里')
    helper.succeedFrom = 1 // 一调即成功，代表模型读完提醒后改用别的方法
    seedSession('streak-b', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_b__', 'load-b1'),
      () => loadToolCall('__streak_ok_b__', 'load-b2'),
      () => toolCallsResponse([{ name: '__streak_fail_b__', args: { attempt: 1 }, id: 'fail-b1' }]),
      () => toolCallsResponse([{ name: '__streak_ok_b__', args: {}, id: 'ok-b1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('streak-b', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 单次失败就够：第 4 次请求带上 count=1 的提醒。
    expect(systemTexts[3]).toContain('· __streak_fail_b__：调用失败；错误：EPERM: 权限不足')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 一次性消费：整个 run 内这条提醒只出现在那一轮，不会每轮重放。
    expect(systemTexts.filter((text) => text.includes(NOTICE_MARK))).toHaveLength(1)
  })

  it('注入后该工具成功一次 → streak 清零，其后不再注入', async () => {
    const flaky = registerFlakyTool('__streak_fail_c__', 'ETIMEDOUT: 请求超时')
    flaky.succeedFrom = 3 // 前两次失败，第三次成功
    seedSession('streak-c', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_c__', 'load-c'),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 1 }, id: 'fail-c1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 2 }, id: 'fail-c2' }]),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 3 }, id: 'ok-c3' }]),
      () => jsonResponse('换了参数之后成功了'),
    ])

    await runSession('streak-c', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 第 3、4 次请求各带一次提醒（分别是第 1、2 次失败的回声）；
    // 成功那一轮之后（第 5 次请求）必须清零、不再注入。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    expect(systemTexts[4]).not.toContain(NOTICE_MARK)
  })

  it('提醒是一次性消费：模型改道后不再被过时提醒骚扰', async () => {
    registerFlakyTool('__streak_fail_f__', 'ENOTDIR: 路径不是目录')
    const helper = registerFlakyTool('__streak_ok_f__', '不会走到这里')
    helper.succeedFrom = 1 // 这个工具一调即成功，用来代表「模型改用别的方法」
    seedSession('streak-f', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_f__', 'load-f1'),
      () => loadToolCall('__streak_ok_f__', 'load-f2'),
      () => toolCallsResponse([{ name: '__streak_fail_f__', args: { attempt: 1 }, id: 'fail-f1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_f__', args: { attempt: 2 }, id: 'fail-f2' }]),
      // 这一轮模型收到提醒后改道：不再碰失败的工具，改用另一个工具并成功。
      () => toolCallsResponse([{ name: '__streak_ok_f__', args: {}, id: 'ok-f1' }]),
      () => jsonResponse('换了个方法，已经做完了'),
    ])

    await runSession('streak-f', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(6)
    // 第 4 次请求：紧跟第 1 次失败（count=1 的单次分支）。
    expect(systemTexts[3]).toContain('· __streak_fail_f__：调用失败；错误：ENOTDIR: 路径不是目录')
    // 第 5 次请求：紧跟第 2 次失败（count=2 的多次分支）。
    expect(systemTexts[4]).toContain('· __streak_fail_f__：已连续失败 2 次')
    expect(systemTexts[4]).toContain(NOTICE_MARK)
    // 第 6 次请求：模型已改道并成功，那条提醒不得再发一遍（否则每轮都在重放过时噪音）。
    expect(systemTexts[5]).not.toContain(NOTICE_MARK)
  })

  it('用户中途插话 → 连败计数与待发提醒一并作废（新语境）', async () => {
    registerFlakyTool('__streak_fail_g__', 'EBUSY: 资源占用中')
    seedSession('streak-g', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_g__', 'load-g'),
      () => toolCallsResponse([{ name: '__streak_fail_g__', args: { attempt: 1 }, id: 'fail-g1' }]),
      () => {
        // 第 2 次失败即将发生（它会写入新的一条提醒）；先排入一条用户插话，
        // 下一轮边界的 promoteQueuedInputs 会把它提升成新语境并清空失败计数与待发提醒。
        const runId = getSessionStore('streak-g').store.getter(runAtom)?.runId
        enqueueUserMessage('streak-g', {
          id: 'q-streak-g',
          createdAt: Date.now(),
          content: '换个思路吧',
          targetRunId: runId!,
        })
        return toolCallsResponse([{ name: '__streak_fail_g__', args: { attempt: 2 }, id: 'fail-g2' }])
      },
      () => jsonResponse('好'),
    ])

    await runSession('streak-g', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const items = getSessionStore('streak-g').store.getter(itemsAtom)
    // 前置条件：插话确实被提升成了 user 消息（否则本用例证明不了「清零」）。
    expect(items.some((it) => it.item.role === 'user' && it.item.content === '换个思路吧')).toBe(true)
    expect(systemTexts).toHaveLength(4)
    // 正向对照：第 3 次请求带着第 1 次失败的提醒（此时还没插话）。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    // 第 4 次请求本该带第 2 次失败的提醒，但用户插话把语境清空了。
    expect(systemTexts[3]).not.toContain(NOTICE_MARK)
  })

  it('提醒只进请求投影，绝不落进持久历史 items', async () => {
    registerFlakyTool('__streak_fail_d__', 'EACCES: 目录不可写')
    seedSession('streak-d', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_d__', 'load-d'),
      () => toolCallsResponse([{ name: '__streak_fail_d__', args: { attempt: 1 }, id: 'fail-d1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_d__', args: { attempt: 2 }, id: 'fail-d2' }]),
      () => jsonResponse('好'),
    ])

    await runSession('streak-d', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 前置条件：提醒确实注入过（否则本用例会假绿）。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    const items = getSessionStore('streak-d').store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'system')).toBe(false)
    expect(JSON.stringify(items)).not.toContain(NOTICE_MARK)
  })

  it('并发分支（整批只读工具）同样计入失败', async () => {
    registerFlakyTool('__streak_par_a__', 'ENOENT: A 不存在', { parallel: true })
    registerFlakyTool('__streak_par_b__', 'ENOENT: B 不存在', { parallel: true })
    seedSession('streak-par', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_par_a__', 'load-par-a'),
      () => loadToolCall('__streak_par_b__', 'load-par-b'),
      // 整批都是 parallel 且 >1 → 走并发分支。
      () => toolCallsResponse([
        { name: '__streak_par_a__', args: { attempt: 1 }, id: 'par-a1' },
        { name: '__streak_par_b__', args: { attempt: 1 }, id: 'par-b1' },
      ]),
      () => toolCallsResponse([
        { name: '__streak_par_a__', args: { attempt: 2 }, id: 'par-a2' },
        { name: '__streak_par_b__', args: { attempt: 2 }, id: 'par-b2' },
      ]),
      () => jsonResponse('两个只读工具都失败了'),
    ])

    await runSession('streak-par', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 第 4 次请求：整批第 1 次失败之后，同一条提醒里把两个工具都列全（count 均为 1）。
    expect(systemTexts[3]).toContain('· __streak_par_a__：调用失败；错误：ENOENT: A 不存在')
    expect(systemTexts[3]).toContain('· __streak_par_b__：调用失败；错误：ENOENT: B 不存在')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 第 5 次请求：两个工具都升到 count=2。
    expect(systemTexts[4]).toContain('· __streak_par_a__：已连续失败 2 次')
    expect(systemTexts[4]).toContain('· __streak_par_b__：已连续失败 2 次')
    expect(systemTexts[4]).toContain(NOTICE_MARK)
  })
})
