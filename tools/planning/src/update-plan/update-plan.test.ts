import { describe, expect, it, vi } from 'vitest'
import type { PlanMutationResult, PlanSnapshot, UpdatePlanInput } from '@einfach-agent/core/planning'
import type { ToolContext } from '@einfach-agent/core/tools'
import { updatePlanTool } from './update-plan'

function makeContext(updatePlan?: ToolContext['updatePlan']): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...(updatePlan ? { updatePlan } : {}),
  } as ToolContext
}

const plan: PlanSnapshot = {
  schemaVersion: 4,
  id: 'plan-1',
  title: 'Ship it',
  objective: 'Ship the thing',
  status: 'active',
  revision: 3,
  requiresApproval: false,
  createdAt: 1,
  updatedAt: 3,
  stages: [],
}

const baseInput: UpdatePlanInput = {
  planId: 'plan-1',
  revision: 2,
  stageId: 'build',
  status: 'blocked',
  blockReason: 'waiting for review',
}

describe('update_plan tool', () => {
  it('宿主未提供计划能力时报 PLAN_UNAVAILABLE', async () => {
    const result = await updatePlanTool.execute(baseInput, makeContext())

    expect(result).toMatchObject({ ok: false, code: 'PLAN_UNAVAILABLE', retryable: false })
  })

  // 壳自己不做二次校验/改写：完成与跳过只能由宿主 Evaluation 判定，壳只负责原样转发给 runtime。
  it('原样转发输入给 runtime，不做二次改写', async () => {
    const updatePlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan }))

    await updatePlanTool.execute(baseInput, makeContext(updatePlan))

    expect(updatePlan).toHaveBeenCalledWith(baseInput)
  })

  it('runtime 拒绝更新（ok:false）→ PLAN_UPDATE_REJECTED，透传 runtime 的错误文案', async () => {
    const updatePlan = vi.fn(async (): Promise<PlanMutationResult> => ({
      ok: false,
      error: 'stage build is pending, not in_progress',
    }))

    const result = await updatePlanTool.execute(baseInput, makeContext(updatePlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'stage build is pending, not in_progress',
      code: 'PLAN_UPDATE_REJECTED',
      retryable: false,
    })
  })

  it('runtime 抛出异常 → PLAN_INVALID_INPUT，错误信息带 update_plan 前缀', async () => {
    const updatePlan = vi.fn(async (): Promise<PlanMutationResult> => {
      throw new Error('store unavailable')
    })

    const result = await updatePlanTool.execute(baseInput, makeContext(updatePlan))

    expect(result).toMatchObject({
      ok: false,
      error: 'update_plan failed: store unavailable',
      code: 'PLAN_INVALID_INPUT',
      retryable: false,
    })
  })

  it('runtime 成功更新 → 返回最新计划快照', async () => {
    const updatePlan = vi.fn(async (): Promise<PlanMutationResult> => ({ ok: true, plan }))

    const result = await updatePlanTool.execute(baseInput, makeContext(updatePlan))

    expect(result).toEqual({ ok: true, data: plan })
  })
})
