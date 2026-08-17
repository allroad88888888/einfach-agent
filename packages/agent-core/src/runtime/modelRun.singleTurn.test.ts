// 拆分自 modelRun.test.ts（T1）。P-R2 最小单轮 run：基础往返、追加输入排队、abort/错误分流、
// stale-run 与 esc race —— 不含请求投影 / 注入卡片相关用例（见 requestProjection / promptInjectionCards）。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { runtimeTranscriptEventsAtom, contextStatsAtom, queuedUserMessagesAtom, enqueueUserMessage } from '../state/transientAtoms'
import { runSession } from './modelRun'
import { createCoreInstance } from './core/coreInstance'
import { registerStandardTools } from '@web-agent/tools'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, clone, waitUntil } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（P-R2 最小单轮 run / 基础生命周期）', () => {
  it('passes only the current CoreInstance model user identity into the request body', async () => {
    const core = createCoreInstance({
      config: { modelUserId: 'wa_isolated_core_0123' },
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
    expect(store.getter(queuedUserMessagesAtom)).toEqual([
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
    // 用户消息已在请求前写进同一工作 checkpoint；运行态只由 v1 recovery 管理。
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
  })
})
