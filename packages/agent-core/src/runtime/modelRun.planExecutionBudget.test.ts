// 拆分自 modelRun.test.ts（T1）。T-6 计划执行的轮次预算与续跑流程：666 轮上限、按阶段数放大预算、
// 计划恢复续跑、文本总结继续运行、停止自动续跑、续跑提醒带拒绝原因。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom, planAtom } from '../state/sessionAtoms'
import { toolRegistry } from '../tools/registry'
import { resumePlanSession, runSession } from './modelRun'
import { resetModelRunTestState, captureCheckpointPersistence, seedSession, jsonResponse, toolCallsResponse, seqFetch } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（多轮 lazy-tool 循环，T-6）计划轮次预算', () => {
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
    const planCompletion = assistantItems.find((item) => item.item.content === '计划已通过验收并完成')
    expect(planCompletion).toMatchObject({
      item: { content: '计划已通过验收并完成' },
    })
    expect(planCompletion).not.toHaveProperty('planStageId')
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
})
