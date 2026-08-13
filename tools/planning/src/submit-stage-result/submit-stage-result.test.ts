import { describe, expect, it, vi } from 'vitest'
import { PlanRuntime } from '../planRuntime'
import type { PlanSnapshot } from '@web-agent/core/planning'
import type { ToolContext } from '@web-agent/core/tools'
import { submitStageResultTool } from './submit-stage-result'

function baseContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'session-1',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...overrides,
  }
}

/** 默认两个阶段；singleStage 用于覆盖「最后一个阶段完成 → 计划完成」。 */
function harness(singleStage = false) {
  let plan: PlanSnapshot | undefined
  let now = 0
  const store = {
    get: () => plan,
    set: (next: PlanSnapshot | undefined) => { plan = next },
  }
  const planning = new PlanRuntime(store, () => ++now, () => 'plan-1')
  const created = planning.create({
    title: 'Delivery',
    objective: 'Ship safely',
    stages: singleStage
      ? [{ id: 'build', title: 'Build', objective: 'Implement' }]
      : [
        { id: 'build', title: 'Build', objective: 'Implement' },
        { id: 'release', title: 'Release', objective: 'Package', dependencies: ['build'] },
      ],
  })
  if (!created.ok) throw new Error(created.error)
  const started = planning.execute(created.plan.id, created.plan.revision)
  if (!started.ok) throw new Error(started.error)
  return {
    planning,
    revision: started.plan.revision,
    plan: () => store.get(),
    stageStatuses: () => store.get()?.stages.map((stage) => stage.status),
  }
}

function submit(
  instance: ReturnType<typeof harness>,
  args: Partial<{ planId: string; revision: number; stageId: string; summary: string; evidence: string[] }> = {},
) {
  return submitStageResultTool.execute({
    planId: 'plan-1',
    revision: instance.revision,
    stageId: 'build',
    summary: 'Implemented',
    evidence: ['3 tests passed'],
    ...args,
  }, baseContext({
    submitStageResult: (input) => instance.planning.submitStageResult(input),
  }))
}

describe('submit_stage_result tool', () => {
  it('完成当前阶段并激活下一个依赖就绪阶段', async () => {
    const instance = harness()

    const result = await submit(instance)

    expect(result).toMatchObject({ ok: true, data: { status: 'active' } })
    expect(instance.stageStatuses()).toEqual(['completed', 'in_progress'])
    expect(instance.plan()?.stages[0].result).toMatchObject({
      summary: 'Implemented',
      evidence: ['3 tests passed'],
    })
  })

  it('最后一个阶段完成后计划直接完成', async () => {
    const instance = harness(true)

    const result = await submit(instance)

    expect(result).toMatchObject({ ok: true, data: { status: 'completed' } })
    expect(instance.stageStatuses()).toEqual(['completed'])
  })

  it('summary 或 evidence 为空时拒绝提交，阶段保持 in_progress', async () => {
    const instance = harness()

    expect(await submit(instance, { summary: '   ' })).toMatchObject({
      ok: false,
      error: 'stage result requires summary',
      code: 'PLAN_STAGE_SUBMISSION_REJECTED',
    })
    expect(await submit(instance, { evidence: ['  '] })).toMatchObject({
      ok: false,
      error: 'stage result requires evidence',
    })
    expect(instance.stageStatuses()).toEqual(['in_progress', 'pending'])
  })

  it('revision 过期时 fail-closed，不推进计划', async () => {
    const instance = harness()

    const result = await submit(instance, { revision: instance.revision + 1 })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('revision conflict'),
      retryable: false,
    })
    expect(instance.stageStatuses()).toEqual(['in_progress', 'pending'])
  })

  it('不能提交未在执行中的阶段', async () => {
    const instance = harness()

    const result = await submit(instance, { stageId: 'release' })

    expect(result).toMatchObject({
      ok: false,
      error: 'stage release is pending, not in_progress',
    })
  })

  it('宿主未提供计划能力时报 PLAN_UNAVAILABLE', async () => {
    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: 1,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed'],
    }, baseContext({}))

    expect(result).toMatchObject({ ok: false, code: 'PLAN_UNAVAILABLE', retryable: false })
  })
})
