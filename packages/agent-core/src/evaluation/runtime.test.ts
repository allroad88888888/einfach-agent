import { describe, expect, it } from 'vitest'
import { PlanRuntime } from '../planning/runtime'
import type { PlanSnapshot } from '../planning/types'
import { EvaluationRuntime } from './runtime'

function harness(stageACriteria: string[] = ['测试通过']) {
  let plan: PlanSnapshot | undefined
  let time = 0
  const store = { get: () => plan, set: (next: PlanSnapshot | undefined) => { plan = next } }
  const planning = new PlanRuntime(store, () => ++time, () => 'p1')
  const evaluation = new EvaluationRuntime(store, () => ++time)
  const created = planning.create({
    title: '交付', objective: '可靠完成', stages: [
      { id: 'a', title: '实现', objective: '写代码', acceptanceCriteria: stageACriteria },
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

  it('unknown 判定落 blocked 并留下阻塞原因，仍可 execute_plan 重试', () => {
    const { planning, evaluation, started } = harness()
    const submitted = evaluation.submitStageResult({ planId: 'p1', revision: started.plan.revision, stageId: 'a', summary: '已实现', evidence: ['见改动'] })
    if (!submitted.ok) throw new Error(submitted.error)
    const unknown = evaluation.evaluateStage({
      planId: 'p1', revision: submitted.plan.revision, stageId: 'a',
      criteria: [{ criterion: '测试通过', status: 'unknown', evidence: [], reason: '评估器无 shell 执行能力' }],
    })
    if (!unknown.ok) throw new Error(unknown.error)
    expect(unknown.plan.stages.map((stage) => stage.status)).toEqual(['blocked', 'pending'])
    expect(unknown.plan.stages[0].blockReason).toBe('评估器无 shell 执行能力')
    expect(unknown.plan.stages[0].evaluations?.at(-1)?.status).toBe('unknown')
    expect(unknown.plan.status).toBe('active')
    const retried = planning.execute('p1', unknown.plan.revision)
    expect(retried.ok && retried.plan.stages[0].status).toBe('in_progress')
  })

  it('多条 unknown 理由拼成 blockReason；含 failed 时仍落 failed 且不写 blockReason', () => {
    const blocked = harness(['测试通过', '构建通过'])
    const blockedSubmit = blocked.evaluation.submitStageResult({ planId: 'p1', revision: blocked.started.plan.revision, stageId: 'a', summary: '已实现', evidence: ['见改动'] })
    if (!blockedSubmit.ok) throw new Error(blockedSubmit.error)
    const unknown = blocked.evaluation.evaluateStage({
      planId: 'p1', revision: blockedSubmit.plan.revision, stageId: 'a',
      criteria: [
        { criterion: '测试通过', status: 'unknown', evidence: [], reason: '无法执行测试' },
        { criterion: '构建通过', status: 'unknown', evidence: [], reason: '无法执行构建' },
      ],
    })
    expect(unknown.ok && unknown.plan.stages[0].blockReason).toBe('无法执行测试; 无法执行构建')

    const failedCase = harness(['测试通过', '构建通过'])
    const failedSubmit = failedCase.evaluation.submitStageResult({ planId: 'p1', revision: failedCase.started.plan.revision, stageId: 'a', summary: '已实现', evidence: ['见改动'] })
    if (!failedSubmit.ok) throw new Error(failedSubmit.error)
    const failed = failedCase.evaluation.evaluateStage({
      planId: 'p1', revision: failedSubmit.plan.revision, stageId: 'a',
      criteria: [
        { criterion: '测试通过', status: 'failed', evidence: [], reason: '断言失败' },
        { criterion: '构建通过', status: 'unknown', evidence: [], reason: '无法执行构建' },
      ],
    })
    if (!failed.ok) throw new Error(failed.error)
    expect(failed.plan.stages[0].status).toBe('failed')
    expect(failed.plan.stages[0].blockReason).toBeUndefined()
    expect(failed.plan.status).toBe('active')
  })

})
