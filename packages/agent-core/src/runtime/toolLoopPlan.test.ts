// P2 验收:计划定义只随 revision 变化(阶段推进不重写),状态条短且随推进变化。
import { afterEach, describe, expect, it } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { planAtom } from '../state/sessionAtoms'
import type { PlanSnapshot, PlanStage } from '../planning/types'
import { defaultCore } from './core/coreInstance'
import { currentPlanDefinition, currentPlanState, planIsExecuting } from './toolLoopPlan'

const SESSION_ID = 'plan-context-split'

function stage(id: string, status: PlanStage['status']): PlanStage {
  return {
    id,
    title: `阶段 ${id}`,
    objective: `目标 ${id}`,
    deliverables: [`产出 ${id}`],
    dependencies: [],
    status,
    evidence: [],
  }
}

function seedPlan(stages: PlanStage[], status: PlanSnapshot['status'] = 'active'): void {
  rootStore.setter(sessionsAtom, (sessions) => ({
    ...sessions,
    [SESSION_ID]: { id: SESSION_ID, title: 't', settings: { vendor: 'deepseek', model: 'm' }, createdAt: 0, updatedAt: 0 },
  }))
  getSessionStore(SESSION_ID).store.setter(planAtom, {
    id: 'plan-1',
    title: '计划',
    objective: '测试拆分',
    status,
    revision: 1,
    requiresApproval: false,
    createdAt: 0,
    updatedAt: 0,
    stages,
  })
}

afterEach(() => {
  resetSessionStores()
  rootStore.setter(sessionsAtom, (sessions) => {
    const { [SESSION_ID]: _removed, ...remaining } = sessions
    return remaining
  })
})

describe('计划控制项拆分', () => {
  it('阶段推进只改状态条,定义逐字不变', () => {
    seedPlan([stage('s1', 'in_progress'), stage('s2', 'pending')])
    const definitionBefore = currentPlanDefinition(SESSION_ID, defaultCore)
    const stateBefore = currentPlanState(SESSION_ID, defaultCore)

    seedPlan([stage('s1', 'completed'), stage('s2', 'in_progress')])
    const definitionAfter = currentPlanDefinition(SESSION_ID, defaultCore)
    const stateAfter = currentPlanState(SESSION_ID, defaultCore)

    expect(definitionAfter).toBe(definitionBefore)
    expect(stateAfter).not.toBe(stateBefore)
    expect(stateAfter).toContain('"currentStageId":"s2"')
    expect(stateAfter).toContain('s1:completed')
  })

  it('定义含完整阶段定义与 planId/revision,状态条不含阶段正文', () => {
    seedPlan([stage('s1', 'in_progress')])
    const definition = currentPlanDefinition(SESSION_ID, defaultCore)
    const state = currentPlanState(SESSION_ID, defaultCore)

    expect(definition).toContain('"planId":"plan-1"')
    expect(definition).toContain('"revision":1')
    expect(definition).toContain('"stageId":"s1"')
    expect(definition).toContain('产出 s1')
    expect(definition).not.toContain('in_progress')

    expect(state).toContain('"planId":"plan-1"')
    expect(state).not.toContain('产出 s1')
    expect((state ?? '').length).toBeLessThan((definition ?? '').length)
  })

  it('无执行态计划时两条都不产生,planIsExecuting 同口径', () => {
    seedPlan([stage('s1', 'in_progress')], 'completed')
    expect(currentPlanDefinition(SESSION_ID, defaultCore)).toBeUndefined()
    expect(currentPlanState(SESSION_ID, defaultCore)).toBeUndefined()
    expect(planIsExecuting(SESSION_ID, defaultCore)).toBe(false)

    seedPlan([stage('s1', 'in_progress')], 'active')
    expect(planIsExecuting(SESSION_ID, defaultCore)).toBe(true)
  })
})
