import { describe, expect, it } from 'vitest'
import { PlanRuntime } from './planRuntime'
import type { CreatePlanInput, PlanSnapshot } from '@web-agent/core/planning/types'

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
    { id: 'design', title: '设计', objective: '确定协议' },
    { id: 'build', title: '实现', objective: '完成代码', dependencies: ['design'] },
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

  it('提交阶段结果完成该阶段、激活下一阶段，最后一个阶段完成后计划结束', () => {
    const { runtime } = harness()
    const created = runtime.create({ ...input, stages: [...input.stages] })
    if (!created.ok) throw new Error(created.error)
    const started = runtime.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const first = runtime.submitStageResult({
      planId: started.plan.id, revision: started.plan.revision, stageId: 'design',
      summary: '协议已确定', evidence: ['docs/protocol.md'],
    })
    if (!first.ok) throw new Error(first.error)
    expect(first.plan.status).toBe('active')
    expect(first.plan.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
    expect(first.plan.stages[0].result).toMatchObject({ summary: '协议已确定', evidence: ['docs/protocol.md'] })
    expect(first.plan.stages[0].evidence).toEqual(['docs/protocol.md'])

    const second = runtime.submitStageResult({
      planId: first.plan.id, revision: first.plan.revision, stageId: 'build',
      summary: '代码完成', evidence: ['pnpm test → 12 passed'],
    })
    expect(second.ok && second.plan.status).toBe('completed')
    expect(second.ok && second.plan.stages.every((stage) => stage.status === 'completed')).toBe(true)
  })

  it('提交必须带 summary 与 evidence，且只能提交执行中的阶段', () => {
    const { runtime } = harness()
    const created = runtime.create({ ...input, stages: [...input.stages] })
    if (!created.ok) throw new Error(created.error)
    const started = runtime.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)
    const args = { planId: started.plan.id, revision: started.plan.revision, stageId: 'design' }

    expect(runtime.submitStageResult({ ...args, summary: '  ', evidence: ['x'] }))
      .toMatchObject({ ok: false, error: 'stage result requires summary' })
    expect(runtime.submitStageResult({ ...args, summary: 'ok', evidence: ['   '] }))
      .toMatchObject({ ok: false, error: 'stage result requires evidence' })
    // 依赖未就绪的后续阶段还没 in_progress，不能被抢先提交。
    expect(runtime.submitStageResult({ ...args, stageId: 'build', summary: 'ok', evidence: ['x'] }))
      .toMatchObject({ ok: false, error: 'stage build is pending, not in_progress' })
    expect(runtime.submitStageResult({ ...args, revision: started.plan.revision + 1, summary: 'ok', evidence: ['x'] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('revision conflict') })
  })

  it('拒绝环依赖和过期 revision', () => {
    const { runtime } = harness()
    expect(runtime.create({
      title: '环', objective: '错误计划', stages: [
        { id: 'a', title: 'A', objective: 'A', dependencies: ['b'] },
        { id: 'b', title: 'B', objective: 'B', dependencies: ['a'] },
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
      stages: [
        { id: 'design', title: '设计', objective: '确定协议', deliverables: [], dependencies: [], status: 'completed', evidence: ['design proof'] },
        { id: 'build', title: '实现', objective: '完成代码', deliverables: [], dependencies: ['design'], status: 'completed', evidence: ['build proof'] },
        { id: 'verify', title: '验证', objective: '回归验证', deliverables: [], dependencies: ['build'], status: 'completed', evidence: ['verify proof'] },
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
        stages: [
          { id: 'design', status: 'completed', evidence: ['design proof'] },
          { id: 'build', status: 'in_progress', evidence: [], result: undefined },
          { id: 'verify', status: 'pending', evidence: [], result: undefined },
        ],
      },
    })
    expect(completed.revision).toBe(9)
  })
})

