import { describe, expect, it } from 'vitest'
import { PlanRuntime } from './runtime'
import type { CreatePlanInput, PlanSnapshot } from './types'

function harness() {
  let plan: PlanSnapshot | undefined
  let time = 10
  const runtime = new PlanRuntime(
    { get: () => plan, set: (next) => { plan = next } },
    () => ++time,
    () => 'plan-1',
  )
  return { runtime, getPlan: () => plan }
}

const input: CreatePlanInput = {
  title: '交付功能',
  objective: '完成实现与验证',
  stages: [
    { id: 'design', title: '设计', objective: '确定协议', acceptanceCriteria: ['协议可验证'] },
    { id: 'build', title: '实现', objective: '完成代码', acceptanceCriteria: ['测试通过'], dependencies: ['design'] },
  ],
}

describe('PlanRuntime', () => {
  it('required 计划必须宿主批准，execute 才激活首阶段', () => {
    const { runtime } = harness()
    const created = runtime.create({ ...input, stages: [...input.stages], approvalMode: 'required' })
    expect(created.ok && created.plan.status).toBe('awaiting_approval')
    if (!created.ok) return
    expect(runtime.execute(created.plan.id, created.plan.revision)).toMatchObject({ ok: false })
    const approved = runtime.approve(created.plan.id, created.plan.revision, true)
    if (!approved.ok) throw new Error(approved.error)
    const started = runtime.execute(approved.plan.id, approved.plan.revision)
    expect(started.ok && started.plan.stages[0].status).toBe('in_progress')
  })

  it('禁止 update 直接完成或跳过，只允许记录阻塞', () => {
    const { runtime } = harness()
    const created = runtime.create({ ...input, stages: [...input.stages], approvalMode: 'auto' })
    if (!created.ok) throw new Error(created.error)
    const started = runtime.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)
    expect(runtime.update({ planId: started.plan.id, revision: started.plan.revision, stageId: 'design', status: 'completed' } as never)).toMatchObject({ ok: false })
    expect(runtime.update({ planId: started.plan.id, revision: started.plan.revision, stageId: 'design', status: 'skipped' } as never)).toMatchObject({ ok: false })
    expect(runtime.update({ planId: started.plan.id, revision: started.plan.revision, stageId: 'design', status: 'blocked' })).toMatchObject({ ok: false })
    const blocked = runtime.update({ planId: started.plan.id, revision: started.plan.revision, stageId: 'design', status: 'blocked', blockReason: '缺少接口权限' })
    expect(blocked.ok && blocked.plan.stages[0].status).toBe('blocked')
  })

  it('拒绝环依赖和过期 revision', () => {
    const { runtime } = harness()
    expect(runtime.create({
      title: '环', objective: '错误计划', stages: [
        { id: 'a', title: 'A', objective: 'A', acceptanceCriteria: ['A'], dependencies: ['b'] },
        { id: 'b', title: 'B', objective: 'B', acceptanceCriteria: ['B'], dependencies: ['a'] },
      ],
    })).toMatchObject({ ok: false })
    const created = runtime.create({ ...input, stages: [...input.stages] })
    if (!created.ok) throw new Error(created.error)
    expect(runtime.execute(created.plan.id, created.plan.revision + 1)).toMatchObject({ ok: false, error: expect.stringContaining('revision conflict') })
  })

  it('回滚阶段会重置目标及其下游阶段，但保留已完成的前置阶段', () => {
    let completed: PlanSnapshot = {
      id: 'plan-1', title: '交付功能', objective: '完成实现与验证', status: 'completed', revision: 8,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      evaluation: { status: 'passed', evidence: ['all checks passed'], reason: '', evaluatedAt: 1, requiresUserAcceptance: false },
      stages: [
        { id: 'design', title: '设计', objective: '确定协议', deliverables: [], acceptanceCriteria: ['协议可验证'], dependencies: [], status: 'completed', evidence: ['design proof'] },
        { id: 'build', title: '实现', objective: '完成代码', deliverables: [], acceptanceCriteria: ['测试通过'], dependencies: ['design'], status: 'completed', evidence: ['build proof'] },
        { id: 'verify', title: '验证', objective: '回归验证', deliverables: [], acceptanceCriteria: ['回归通过'], dependencies: ['build'], status: 'completed', evidence: ['verify proof'] },
      ],
    }
    const rollbackRuntime = new PlanRuntime(
      { get: () => completed, set: (next) => { if (next) completed = next } },
      () => 20,
      () => 'plan-1',
    )
    const rolledBack = rollbackRuntime.rollbackStage(completed.id, completed.revision, 'build')

    expect(rolledBack).toMatchObject({
      ok: true,
      plan: {
        status: 'active',
        evaluation: undefined,
        stages: [
          { id: 'design', status: 'completed', evidence: ['design proof'] },
          { id: 'build', status: 'in_progress', evidence: [], evaluations: [] },
          { id: 'verify', status: 'pending', evidence: [], evaluations: [] },
        ],
      },
    })
    expect(completed.revision).toBe(9)
  })
})
