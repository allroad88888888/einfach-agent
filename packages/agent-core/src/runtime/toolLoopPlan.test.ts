// P2 验收:计划定义只随 revision 变化(阶段推进不重写),状态条短且随推进变化。
import { afterEach, describe, expect, it } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { planAtom } from '../state/sessionAtoms'
import type { PlanSnapshot, PlanStage } from '../planning/types'
import { defaultCore } from './core/coreInstance'
import { currentPlanDefinition, currentPlanState, planIsExecuting } from './toolLoopPlan'

const SESSION_ID = 'plan-context-split'

function stage(id: string, status: PlanStage['status'], evidence: string[] = []): PlanStage {
  return {
    id,
    title: `阶段 ${id}`,
    objective: `目标 ${id}`,
    deliverables: [`产出 ${id}`],
    dependencies: [],
    status,
    evidence,
  }
}

function seedPlan(stages: PlanStage[], status: PlanSnapshot['status'] = 'active', revision = 1): void {
  rootStore.setter(sessionsAtom, (sessions) => ({
    ...sessions,
    [SESSION_ID]: { id: SESSION_ID, title: 't', settings: { vendor: 'deepseek', model: 'm' }, createdAt: 0, updatedAt: 0 },
  }))
  getSessionStore(SESSION_ID).store.setter(planAtom, {
    id: 'plan-1',
    title: '计划',
    objective: '测试拆分',
    status,
    revision,
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
  it('阶段推进(生产形态:revision+1、evidence 追加)只改状态条,定义逐字不变', () => {
    // PlanRuntime 的 write() 每次变更都 revision+1,submit_stage_result 还追加 evidence。
    // 定义必须对这两者免疫,否则"拆分"在生产里每个阶段照样整条重写(2026-08-04 评审)。
    seedPlan([stage('s1', 'in_progress'), stage('s2', 'pending')], 'active', 1)
    const definitionBefore = currentPlanDefinition(SESSION_ID, defaultCore)
    const stateBefore = currentPlanState(SESSION_ID, defaultCore)

    seedPlan([stage('s1', 'completed', ['s1 的验收证据']), stage('s2', 'in_progress')], 'active', 2)
    const definitionAfter = currentPlanDefinition(SESSION_ID, defaultCore)
    const stateAfter = currentPlanState(SESSION_ID, defaultCore)

    expect(definitionAfter).toBe(definitionBefore)
    expect(stateAfter).not.toBe(stateBefore)
    expect(stateAfter).toContain('"currentStageId":"s2"')
    expect(stateAfter).toContain('"revision":2')
    expect(stateAfter).toContain('{"stageId":"s1","status":"completed"}')
  })

  it('定义含完整阶段定义与 planId,revision 只在状态条;状态条不含阶段正文', () => {
    seedPlan([stage('s1', 'in_progress')])
    const definition = currentPlanDefinition(SESSION_ID, defaultCore)
    const state = currentPlanState(SESSION_ID, defaultCore)

    expect(definition).toContain('"planId":"plan-1"')
    expect(definition).not.toContain('"revision"')
    expect(definition).toContain('"stageId":"s1"')
    expect(definition).toContain('产出 s1')
    expect(definition).not.toContain('in_progress')

    expect(state).toContain('"planId":"plan-1"')
    expect(state).toContain('"revision":1')
    expect(state).not.toContain('产出 s1')
    expect((state ?? '').length).toBeLessThan((definition ?? '').length)
  })

  it('当前阶段已有 evidence 时随状态条携带(旧 snapshot 的信息不丢失)', () => {
    seedPlan([stage('s1', 'in_progress', ['中途留痕'])])
    const state = currentPlanState(SESSION_ID, defaultCore)
    expect(state).toContain('中途留痕')
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
