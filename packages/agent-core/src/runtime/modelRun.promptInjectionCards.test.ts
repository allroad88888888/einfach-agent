// 拆分自 modelRun.test.ts（T1）。P-R2 单轮 run 里的注入卡片判重、自定义指令变更记录，
// 以及 context stats / context cache trace 统计。

import { describe, it, expect, afterEach } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { runAtom } from '../state/sessionAtoms'
import { runtimeTranscriptEventsAtom, contextStatsAtom } from '../state/transientAtoms'
import { runSession } from './modelRun'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import { createCoreInstance } from './core/coreInstance'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, seqFetch, captureTrace } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（P-R2）注入卡片判重与 context 统计', () => {
  it('注入卡片改为按内容变化判重：同一会话连续两次 runSession 不重复记同一张卡', async () => {
    // 本用例的 core 没装 skill registry，清单段落回退成一句「未装配」；判重逻辑与内容无关。
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
    expect(events.filter((e) => e.title === '注入 skill 清单')).toHaveLength(1)
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
    // 稳定前缀四段：固定 system + 工具摘要 + skill 清单 + 运行环境（本会话无自定义指令）。
    expect(stats?.roles.system.count).toBe(4)
    expect(stats?.roles.user.count).toBe(1)
    // 统计的是**发出去的那一份请求**：首轮里除前缀只有一条 user，模型还没回话。
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
})
