import { describe, expect, it, vi } from 'vitest'
import type { PlanMutationResult, PlanRuntimeFactory, PlanSnapshot } from '../../planning/types'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { itemsAtom, planAtom, planStageCheckpointsAtom, runAtom } from '../../state/sessionAtoms'
import { createCoreInstance } from '../core/coreInstance'
import type { RecoveryWriteOutcome } from '../recoveryWriter'
import { createPlanCommands } from './planCommands'

const sessionId = 'session-1'

function activePlan(): PlanSnapshot {
  return {
    schemaVersion: 4,
    id: 'plan-1',
    title: '恢复计划',
    objective: '先落盘再继续',
    status: 'active',
    revision: 1,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 1,
    stages: [{
      id: 'stage-1',
      title: '实现',
      objective: '完成恢复边界',
      deliverables: [],
      dependencies: [],
      status: 'completed',
      evidence: ['done'],
    }],
  }
}

function rejected(): PlanMutationResult {
  return { ok: false, error: 'not used' }
}

function rollbackRuntime(afterWrite?: () => void): PlanRuntimeFactory {
  return (store) => ({
    get: store.get,
    create: async () => rejected(),
    approve: async () => rejected(),
    execute: async () => rejected(),
    update: async () => rejected(),
    submitStageResult: async () => rejected(),
    async rollbackStage(planId, revision, stageId) {
      const current = store.get()
      if (!current || current.id !== planId || current.revision !== revision || stageId !== 'stage-1') return rejected()
      const next: PlanSnapshot = {
        ...current,
        status: 'active',
        revision: current.revision + 1,
        updatedAt: 2,
        stages: current.stages.map((stage) => ({
          ...stage,
          status: 'in_progress',
          evidence: [],
        })),
      }
      await store.set(next)
      afterWrite?.()
      return { ok: true, plan: next }
    },
  })
}

function seed(core: ReturnType<typeof createCoreInstance>): void {
  core.rootStore.setter(sessionsAtom, {
    [sessionId]: {
      id: sessionId,
      title: '测试会话',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
  core.rootStore.setter(activeSessionIdAtom, sessionId)
  core.getSessionStore(sessionId).store.setter(planAtom, activePlan())
  core.getSessionStore(sessionId).store.setter(runAtom, { runId: 'run-1', status: 'running' })
}

describe('planCommands 的 planRuntime 槽', () => {
  it('未注入时回退计划阶段不会崩溃，并写入中文提示', async () => {
    const core = createCoreInstance({ planRuntime: null })
    const sessionId = 'session-1'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: '测试会话',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.rootStore.setter(activeSessionIdAtom, sessionId)
    const stopRun = vi.fn()

    await expect(createPlanCommands(core, stopRun).rollbackPlanStage('plan-1', 1, 'stage-1')).resolves.toBe(false)
    expect(stopRun).not.toHaveBeenCalled()
    expect(core.getSessionStore(sessionId).store.getter(itemsAtom).at(-1)?.item).toMatchObject({
      role: 'assistant',
      content: '当前运行环境未装配计划能力，无法回退计划阶段。',
    })
  })

  it('未注入时审批计划会返回中文错误并恢复暂停的运行', async () => {
    const core = createCoreInstance({ planRuntime: null })
    const sessionId = 'session-1'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: '测试会话',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.rootStore.setter(activeSessionIdAtom, sessionId)
    core.getSessionStore(sessionId).store.setter(runAtom, {
      runId: 'run-1',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'call-1', planId: 'plan-1', revision: 1 },
    })

    await expect(createPlanCommands(core, vi.fn()).approvePlan(true)).resolves.toBe(true)
    expect(core.getSessionStore(sessionId).store.getter(itemsAtom).at(-1)?.item).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: JSON.stringify({ error: '当前运行环境未装配计划能力，无法审批计划。' }),
    })
    expect(core.getSessionStore(sessionId).store.getter(runAtom)?.pendingPlanApproval).toBeUndefined()
  })

  it('审批恢复启动失败时不拒绝，并把运行留在中断状态', async () => {
    const core = createCoreInstance({ planRuntime: null })
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: '测试会话',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.rootStore.setter(activeSessionIdAtom, sessionId)
    core.getSessionStore(sessionId).store.setter(runAtom, {
      runId: 'run-1',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'call-1', planId: 'plan-1', revision: 1 },
    })
    vi.spyOn(core.abort, 'beginRun').mockImplementation(() => { throw new Error('resume start failed') })

    await expect(createPlanCommands(core, vi.fn()).approvePlan(true)).resolves.toBe(false)

    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({
      status: 'interrupted',
      error: '恢复快照未确认：resume start failed',
    })
  })

  it('回退会等待本实例恢复快照确认后才报告成功', async () => {
    const core = createCoreInstance({ planRuntime: rollbackRuntime() })
    seed(core)
    let acknowledge: (outcome: RecoveryWriteOutcome | undefined) => void = () => undefined
    const persist = vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(() => new Promise<RecoveryWriteOutcome | undefined>((resolve) => {
      acknowledge = resolve
    }))

    const pending = createPlanCommands(core, vi.fn()).rollbackPlanStage('plan-1', 1, 'stage-1')
    let completed = false
    void pending.then(() => { completed = true })
    await Promise.resolve()

    expect(core.getSessionStore(sessionId).store.getter(planAtom)?.stages[0].status).toBe('in_progress')
    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toBeUndefined()
    expect(persist).toHaveBeenCalledWith(sessionId, 'plan.stage')
    expect(completed).toBe(false)
    acknowledge({ status: 'saved', sessionId, generation: 1, attempts: 1 })
    await expect(pending).resolves.toBe(true)
  })

  it('回退持久化被拒绝时中断运行，且不报告成功', async () => {
    let continued = false
    const core = createCoreInstance({ planRuntime: rollbackRuntime(() => { continued = true }) })
    seed(core)
    const event = vi.spyOn(core.observability, 'addEvent')
    vi.spyOn(core.persistence, 'persistRecovery').mockRejectedValue(new Error('disk unavailable'))

    await expect(createPlanCommands(core, vi.fn()).rollbackPlanStage('plan-1', 1, 'stage-1')).resolves.toBe(false)

    expect(continued).toBe(false)
    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({ status: 'interrupted' })
    expect(event).toHaveBeenCalledWith('agent.plan_recovery_persistence_blocked', expect.anything())
  })

  it('checkpoint 回退复用首次 runtime adapter，并以已停止的运行报告持久化失败', async () => {
    const factory = vi.fn(rollbackRuntime())
    const core = createCoreInstance({ planRuntime: factory })
    seed(core)
    const checkpointPlan = activePlan()
    checkpointPlan.revision = 0
    checkpointPlan.stages[0] = { ...checkpointPlan.stages[0], status: 'pending', evidence: [] }
    core.getSessionStore(sessionId).store.setter(planStageCheckpointsAtom, [{
      stageId: 'stage-1', plan: checkpointPlan, itemCount: 0, createdAt: 1,
    }])
    const persist = vi.spyOn(core.persistence, 'persistRecovery').mockRejectedValue(new Error('disk unavailable'))
    const event = vi.spyOn(core.observability, 'addEvent')

    await expect(createPlanCommands(core, vi.fn()).rollbackPlanStage('plan-1', 1, 'stage-1')).resolves.toBe(false)

    expect(factory).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith(sessionId, 'plan.stage_rollback')
    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({
      runId: 'run-1', status: 'interrupted', error: '恢复快照未确认：disk unavailable',
    })
    expect(event).toHaveBeenCalledWith('agent.plan_recovery_persistence_blocked', expect.objectContaining({
      attrs: expect.objectContaining({
        sessionId, runId: 'run-1', reason: 'plan.stage_rollback', error: 'disk unavailable',
      }),
    }))
  })
})
