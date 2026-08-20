import { describe, expect, it, vi } from 'vitest'
import type { PlanMutationResult, PlanSnapshot } from '@einfach-agent/core/planning'
import type { ToolContext } from '@einfach-agent/core/tools'
import { executePlanTool } from './execute-plan'

function makeContext(executePlan?: ToolContext['executePlan']): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...(executePlan ? { executePlan } : {}),
  } as ToolContext
}

const plan: PlanSnapshot = {
  schemaVersion: 4,
  id: 'plan-1',
  title: 'Ship it',
  objective: 'Ship the thing',
  status: 'active',
  revision: 2,
  requiresApproval: false,
  createdAt: 1,
  updatedAt: 2,
  stages: [],
}

describe('execute_plan tool', () => {
  it('宿主未提供计划能力时报 PLAN_UNAVAILABLE', async () => {
    const result = await executePlanTool.execute({ planId: 'plan-1', revision: 1 }, makeContext())

    expect(result).toMatchObject({ ok: false, code: 'PLAN_UNAVAILABLE', retryable: false })
  })

  it.each([
    ['缺 planId', { revision: 1 }],
    ['planId 全是空白', { planId: '   ', revision: 1 }],
    ['revision 不是整数', { planId: 'plan-1', revision: 1.5 }],
    ['revision 小于 1', { planId: 'plan-1', revision: 0 }],
    ['revision 缺失', { planId: 'plan-1' }],
    ['args 不是对象', undefined],
    ['args 是数组', []],
  ])('参数非法（%s）→ PLAN_INVALID_INPUT，且不转发给 runtime', async (_label, args) => {
    const executePlan = vi.fn()

    const result = await executePlanTool.execute(args, makeContext(executePlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'invalid execute_plan: planId and a positive integer revision are required',
      code: 'PLAN_INVALID_INPUT',
      retryable: false,
    })
    expect(executePlan).not.toHaveBeenCalled()
  })

  it('planId 前后空白会被裁剪后再转发给 runtime', async () => {
    const executePlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan }))

    await executePlanTool.execute({ planId: '  plan-1  ', revision: 2 }, makeContext(executePlan))

    expect(executePlan).toHaveBeenCalledWith('plan-1', 2)
  })

  it('runtime 拒绝执行（ok:false）→ PLAN_EXECUTE_REJECTED，透传 runtime 的错误文案', async () => {
    const executePlan = vi.fn(async (): Promise<PlanMutationResult> => ({
      ok: false,
      error: 'plan has no ready stage',
    }))

    const result = await executePlanTool.execute({ planId: 'plan-1', revision: 1 }, makeContext(executePlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'plan has no ready stage',
      code: 'PLAN_EXECUTE_REJECTED',
      retryable: false,
    })
  })

  it('runtime 抛出异常 → PLAN_INVALID_INPUT，错误信息带 execute_plan 前缀', async () => {
    const executePlan = vi.fn(async (): Promise<PlanMutationResult> => {
      throw new Error('store unavailable')
    })

    const result = await executePlanTool.execute({ planId: 'plan-1', revision: 1 }, makeContext(executePlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'execute_plan failed: store unavailable',
      code: 'PLAN_INVALID_INPUT',
      retryable: false,
    })
  })

  it('runtime 成功执行 → 返回最新计划快照', async () => {
    const executePlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan }))

    const result = await executePlanTool.execute({ planId: 'plan-1', revision: 1 }, makeContext(executePlan))

    expect(result).toEqual({ ok: true, data: plan })
  })
})
