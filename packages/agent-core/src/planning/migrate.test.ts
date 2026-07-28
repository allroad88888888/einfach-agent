import { describe, expect, it } from 'vitest'
import { migratePlanSnapshot } from './migrate'
import type { PlanSnapshot } from './types'

/** v3 形态：宿主跑独立评估者，阶段完成由评估结论决定。 */
function legacyV3(overrides: Record<string, unknown> = {}): PlanSnapshot {
  return {
    schemaVersion: 3,
    id: 'plan-legacy',
    title: '旧计划',
    objective: '验证迁移',
    status: 'completed',
    revision: 9,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 2,
    evaluation: { status: 'passed', evidence: ['regression green'], reason: '', evaluatedAt: 5, requiresUserAcceptance: false },
    stages: [{
      id: 'build',
      title: '实现',
      objective: '写代码',
      deliverables: [],
      acceptanceCriteria: ['测试通过'],
      dependencies: [],
      status: 'completed',
      evidence: ['pnpm test'],
      evaluations: [{
        attempt: 1,
        status: 'passed',
        summary: '实现完成',
        submittedEvidence: ['pnpm test → 12 passed'],
        verdictEvidence: ['12 passed'],
        reason: '',
        submittedAt: 3,
        evaluatedAt: 4,
      }],
    }],
    ...overrides,
  } as unknown as PlanSnapshot
}

describe('migratePlanSnapshot', () => {
  it('v3 → v4：丢弃评估结论，保留最后一次提交的产出留痕', () => {
    const migrated = migratePlanSnapshot(legacyV3())

    expect(migrated.schemaVersion).toBe(4)
    expect(migrated).not.toHaveProperty('evaluation')
    expect(migrated.stages[0]).not.toHaveProperty('acceptanceCriteria')
    expect(migrated.stages[0]).not.toHaveProperty('evaluations')
    expect(migrated.stages[0].result).toEqual({
      summary: '实现完成',
      evidence: ['pnpm test → 12 passed'],
      submittedAt: 3,
    })
  })

  it('旧的已完成计划保持完成，不被追溯重开', () => {
    const migrated = migratePlanSnapshot(legacyV3())

    expect(migrated.status).toBe('completed')
    expect(migrated.stages[0].status).toBe('completed')
    expect(migrated.revision).toBe(9)
  })

  // 中断在评估中的阶段当时并没有人确认它做完了，判完成会把未验证的工作永久标成已完成。
  it('中断在 evaluating 的阶段回落 in_progress 而不是 completed', () => {
    const migrated = migratePlanSnapshot(legacyV3({
      status: 'active',
      evaluation: undefined,
      stages: [{
        id: 'build', title: '实现', objective: '写代码', deliverables: [],
        dependencies: [], status: 'evaluating', evidence: [],
        evaluations: [{ attempt: 1, status: 'evaluating', summary: '实现完成', submittedEvidence: ['见改动'], submittedAt: 3 }],
      }],
    }))

    expect(migrated.stages[0].status).toBe('in_progress')
    expect(migrated.stages[0].result?.summary).toBe('实现完成')
  })

  it('计划级 evaluating 回落 active；待验收按用户当时的决定落地', () => {
    expect(migratePlanSnapshot(legacyV3({ status: 'evaluating' })).status).toBe('active')
    expect(migratePlanSnapshot(legacyV3({ status: 'awaiting_user_acceptance' })).status).toBe('completed')
    expect(migratePlanSnapshot(legacyV3({
      status: 'awaiting_user_acceptance',
      userAcceptance: { status: 'rejected', decidedAt: 6 },
    })).status).toBe('failed')
    expect(migratePlanSnapshot(legacyV3({ status: 'rejected' })).status).toBe('failed')
  })

  it('Evaluation 上线前的计划（无 evaluations）不产生产出记录', () => {
    const migrated = migratePlanSnapshot(legacyV3({
      schemaVersion: undefined,
      stages: [{
        id: 'build', title: '实现', objective: '写代码', deliverables: [],
        acceptanceCriteria: ['测试通过'], dependencies: [], status: 'completed', evidence: [],
      }],
    }))

    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.stages[0].result).toBeUndefined()
    expect(migrated.stages[0]).not.toHaveProperty('acceptanceCriteria')
  })

  it('已是 v4 的快照原样返回，不重复分配', () => {
    const current = migratePlanSnapshot(legacyV3())

    expect(migratePlanSnapshot(current)).toBe(current)
  })
})
