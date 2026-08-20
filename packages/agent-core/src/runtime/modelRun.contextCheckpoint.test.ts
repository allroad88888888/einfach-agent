// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { contextCheckpointAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { contextStatsAtom } from '../state/transientAtoms'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { resetModelRunTestState, seedSession, jsonResponse, captureTrace } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
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

    // 稳定前缀四段（固定 system + 工具摘要 + skill 清单 + 运行环境）+ user，共五条。
    expect((captured.messages as unknown[]).length).toBe(5)
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
    expect(store.getter(contextCheckpointAtom)?.coveredItemIds).toHaveLength(5)
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
})
