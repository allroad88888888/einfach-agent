import { describe, expect, it } from 'vitest'
import { PlanRuntime } from '../planning/runtime'
import type { PlanSnapshot } from '../planning/types'
import { EvaluationRuntime } from './runtime'

function harness() {
  let plan: PlanSnapshot | undefined
  let time = 0
  const store = { get: () => plan, set: (next: PlanSnapshot | undefined) => { plan = next } }
  const planning = new PlanRuntime(store, () => ++time, () => 'p1')
  const evaluation = new EvaluationRuntime(store, () => ++time)
  const created = planning.create({
    title: '交付', objective: '可靠完成', stages: [
      { id: 'a', title: '实现', objective: '写代码', acceptanceCriteria: ['测试通过'] },
      { id: 'b', title: '回归', objective: '验证集成', acceptanceCriteria: ['构建通过'], dependencies: ['a'] },
    ],
  })
  if (!created.ok) throw new Error(created.error)
  const started = planning.execute(created.plan.id, created.plan.revision)
  if (!started.ok) throw new Error(started.error)
  return { planning, evaluation, started }
}

describe('EvaluationRuntime', () => {
  it('提交结果不等于完成；必须逐条覆盖且全部通过才推进', () => {
    const { evaluation, started } = harness()
    const submitted = evaluation.submitStageResult({ planId: 'p1', revision: started.plan.revision, stageId: 'a', summary: '已实现', evidence: ['tests: 3 passed'] })
    if (!submitted.ok) throw new Error(submitted.error)
    expect(submitted.plan.stages[0].status).toBe('evaluating')
    expect(evaluation.evaluateStage({ planId: 'p1', revision: submitted.plan.revision, stageId: 'a', criteria: [] })).toMatchObject({ ok: false })
    const passed = evaluation.evaluateStage({
      planId: 'p1', revision: submitted.plan.revision, stageId: 'a',
      criteria: [{ criterion: '测试通过', status: 'passed', evidence: ['tests: 3 passed'], reason: '' }],
    })
    if (!passed.ok) throw new Error(passed.error)
    expect(passed.plan.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('failed/unknown 不解锁依赖，execute_plan 可重试失败阶段', () => {
    const { planning, evaluation, started } = harness()
    const submitted = evaluation.submitStageResult({ planId: 'p1', revision: started.plan.revision, stageId: 'a', summary: '实现不完整', evidence: ['test failed'] })
    if (!submitted.ok) throw new Error(submitted.error)
    const failed = evaluation.evaluateStage({
      planId: 'p1', revision: submitted.plan.revision, stageId: 'a',
      criteria: [{ criterion: '测试通过', status: 'failed', evidence: ['test failed'], reason: '断言失败' }],
    })
    if (!failed.ok) throw new Error(failed.error)
    expect(failed.plan.stages.map((stage) => stage.status)).toEqual(['failed', 'pending'])
    const retried = planning.execute('p1', failed.plan.revision)
    expect(retried.ok && retried.plan.stages[0].status).toBe('in_progress')
  })

  it('最后阶段通过后仍需整体验收；主观结果等待用户接受', () => {
    const { evaluation, started } = harness()
    const first = evaluation.submitStageResult({ planId: 'p1', revision: started.plan.revision, stageId: 'a', summary: 'A', evidence: ['A evidence'] })
    if (!first.ok) throw new Error(first.error)
    const firstPassed = evaluation.evaluateStage({ planId: 'p1', revision: first.plan.revision, stageId: 'a', criteria: [{ criterion: '测试通过', status: 'passed', evidence: ['A evidence'], reason: '' }] })
    if (!firstPassed.ok) throw new Error(firstPassed.error)
    const second = evaluation.submitStageResult({ planId: 'p1', revision: firstPassed.plan.revision, stageId: 'b', summary: 'B', evidence: ['B evidence'] })
    if (!second.ok) throw new Error(second.error)
    const allStagesPassed = evaluation.evaluateStage({ planId: 'p1', revision: second.plan.revision, stageId: 'b', criteria: [{ criterion: '构建通过', status: 'passed', evidence: ['B evidence'], reason: '' }] })
    if (!allStagesPassed.ok) throw new Error(allStagesPassed.error)
    expect(allStagesPassed.plan.status).toBe('evaluating')
    const final = evaluation.evaluatePlan({ planId: 'p1', revision: allStagesPassed.plan.revision, status: 'passed', evidence: ['full regression passed'], requiresUserAcceptance: true })
    if (!final.ok) throw new Error(final.error)
    expect(final.plan.status).toBe('awaiting_user_acceptance')
    const accepted = evaluation.acceptPlan('p1', final.plan.revision, true)
    expect(accepted.ok && accepted.plan.status).toBe('completed')
    if (!accepted.ok) return
    expect(accepted.plan.userAcceptance?.status).toBe('accepted')
  })
})
