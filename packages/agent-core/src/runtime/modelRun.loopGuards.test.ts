// 拆分自 modelRun.test.ts（T1）。T-6 循环安全网：阶段进度 guard、stopped-run 防写回、
// 重复 tool-only 调用 loop_detected、多轮 esc 中途 abort。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, planAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import { resumePlanSession, runSession } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, seqFetch, captureTrace, waitUntil } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（多轮 lazy-tool 循环，T-6）循环安全网', () => {
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
  })
})
