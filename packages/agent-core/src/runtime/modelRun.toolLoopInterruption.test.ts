// 拆分自 modelRun.test.ts（T1）。T-6 工具循环执行期间的中断与并发：observability 脱敏 payload、
// ask_user_question / create_plan 中断、progress 清理、只读工具并发执行图。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom, planAtom } from '../state/sessionAtoms'
import { executionGraphAtom } from '../execution/graph'
import { setRun } from '../state/sessionWriters'
import { toolActivityAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { defaultCore } from './core/coreInstance'
import type { PlanRuntimeFactory } from '../planning/runtime'
import type { CreatePlanInput, PlanRuntimeStore } from '../planning/types'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, seqFetch, captureTrace, waitUntil } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（多轮 lazy-tool 循环，T-6）工具轮中断与并发', () => {
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
})
