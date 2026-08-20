import { describe, expect, it, vi } from 'vitest'
import type { PlanMutationResult, PlanSnapshot } from '@einfach-agent/core/planning'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createPlanTool } from './create-plan'

function makeContext(createPlan?: ToolContext['createPlan']): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...(createPlan ? { createPlan } : {}),
  } as ToolContext
}

const baseInput = {
  title: 'Ship it',
  objective: 'Ship the thing',
  stages: [{ id: 'build', title: 'Build', objective: 'Implement' }],
}

function plan(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    schemaVersion: 4,
    id: 'plan-1',
    title: 'Ship it',
    objective: 'Ship the thing',
    status: 'approved',
    revision: 1,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 1,
    stages: [],
    ...overrides,
  }
}

describe('create_plan tool', () => {
  it('宿主未提供计划能力时报 PLAN_UNAVAILABLE', async () => {
    const result = await createPlanTool.execute(baseInput, makeContext())

    expect(result).toMatchObject({ ok: false, code: 'PLAN_UNAVAILABLE', retryable: false })
  })

  it('runtime 拒绝创建（ok:false）→ PLAN_CREATE_REJECTED，透传 runtime 的错误文案', async () => {
    const createPlan = vi.fn(async (): Promise<PlanMutationResult> => ({
      ok: false,
      error: 'plan title and objective are required',
    }))

    const result = await createPlanTool.execute(baseInput, makeContext(createPlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'plan title and objective are required',
      code: 'PLAN_CREATE_REJECTED',
      retryable: false,
    })
  })

  it('runtime 抛出异常 → PLAN_INVALID_INPUT，错误信息带 create_plan 前缀', async () => {
    const createPlan = vi.fn(async (): Promise<PlanMutationResult> => {
      throw new Error('store unavailable')
    })

    const result = await createPlanTool.execute(baseInput, makeContext(createPlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'create_plan failed: store unavailable',
      code: 'PLAN_INVALID_INPUT',
      retryable: false,
    })
  })

  // 计划域的既有约束：需要审批的计划只能由宿主界面批准，模型不得自行批准或绕过 execute_plan。
  // 这里锁的是壳的分支——runtime 建出 awaiting_approval 快照后，工具必须转成 pause 交还宿主，
  // 而不是直接把计划当创建成功回给模型。
  it('新建计划落在 awaiting_approval 时转为暂停，交由宿主界面批准', async () => {
    const created = plan({ status: 'awaiting_approval', revision: 1, requiresApproval: true })
    const createPlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan: created }))

    const result = await createPlanTool.execute(
      { ...baseInput, approvalMode: 'required' },
      makeContext(createPlan),
    )

    expect(result).toEqual({ pause: { kind: 'plan_approval', planId: 'plan-1', revision: 1 } })
  })

  it('无需审批的计划直接返回创建后的快照，不暂停', async () => {
    const created = plan({ status: 'approved' })
    const createPlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan: created }))

    const result = await createPlanTool.execute(baseInput, makeContext(createPlan))

    expect(result).toEqual({ ok: true, data: created })
  })
})
