import { describe, expect, it, vi } from 'vitest'
import type { PlanRuntimeFactory, PlanSnapshot } from '../planning/types'
import { sessionsAtom } from '../state/rootStore'
import { planAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance } from './core/coreInstance'
import type { RecoveryWriteOutcome } from './recoveryWriter'
import { buildToolContext } from './toolContext'

const sessionId = 'session-1'
const recoveryFailureCases: Array<[string, RecoveryWriteOutcome | Error]> = [
  ['error', { status: 'error', sessionId, error: new Error('disk unavailable') }],
  ['stale', { status: 'stale', sessionId } as unknown as RecoveryWriteOutcome],
  ['tombstoned', { status: 'tombstoned', sessionId }],
  ['skipped', { status: 'skipped', sessionId, reason: 'reset' }],
  ['rejection', new Error('driver rejected')],
]

function plan(): PlanSnapshot {
  return {
    schemaVersion: 4,
    id: 'plan-1',
    title: 'Resume safely',
    objective: 'persist before continuing',
    status: 'active',
    revision: 1,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 1,
    stages: [],
  }
}

describe('ToolContext 的 planRuntime 槽', () => {
  it('未注入时不暴露计划工具能力', () => {
    const ctx = buildToolContext({
      sessionId: 'session-1',
      runId: 'run-1',
      signal: new AbortController().signal,
      callId: 'call-1',
      toolName: 'create_plan',
      core: createCoreInstance({ planRuntime: null }),
    })

    expect(ctx.getPlan).toBeUndefined()
    expect(ctx.createPlan).toBeUndefined()
    expect(ctx.executePlan).toBeUndefined()
    expect(ctx.updatePlan).toBeUndefined()
    expect(ctx.submitStageResult).toBeUndefined()
  })

  it('waits for a saved plan-stage snapshot through the current core bridge', async () => {
    const runtime: PlanRuntimeFactory = (store) => ({
      get: store.get,
      async create() {
        const next = plan()
        await store.set(next)
        return { ok: true, plan: next }
      },
      approve: async () => ({ ok: false, error: 'not used' }),
      execute: async () => ({ ok: false, error: 'not used' }),
      update: async () => ({ ok: false, error: 'not used' }),
      submitStageResult: async () => ({ ok: false, error: 'not used' }),
      rollbackStage: async () => ({ ok: false, error: 'not used' }),
    })
    const core = createCoreInstance({ planRuntime: runtime })
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: 'Recovery session',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 1,
        updatedAt: 1,
      },
    })
    core.getSessionStore(sessionId).store.setter(runAtom, { runId: 'run-1', status: 'running' })
    let acknowledge: (outcome: RecoveryWriteOutcome | undefined) => void = () => undefined
    const persist = vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(() => new Promise<RecoveryWriteOutcome | undefined>((resolve) => {
      acknowledge = resolve
    }))
    const ctx = buildToolContext({
      sessionId,
      runId: 'run-1',
      signal: new AbortController().signal,
      callId: 'call-1',
      toolName: 'create_plan',
      core,
    })

    const pending = ctx.createPlan!({
      title: 'Resume safely', objective: 'persist before continuing', stages: [],
    })
    let completed = false
    void pending.then(() => { completed = true })
    await Promise.resolve()

    expect(core.getSessionStore(sessionId).store.getter(planAtom)).toEqual(plan())
    expect(persist).toHaveBeenCalledWith(sessionId, 'plan.stage')
    expect(completed).toBe(false)
    acknowledge({ status: 'saved', sessionId, generation: 1, attempts: 1 })
    await expect(pending).resolves.toMatchObject({ ok: true, plan: { id: 'plan-1' } })
  })

  it.each(recoveryFailureCases)('blocks a dependent plan action when recovery is %s', async (_name, outcome: RecoveryWriteOutcome | Error) => {
    let continued = false
    const runtime: PlanRuntimeFactory = (store) => ({
      get: store.get,
      async create() {
        const next = plan()
        await store.set(next)
        continued = true
        return { ok: true, plan: next }
      },
      approve: async () => ({ ok: false, error: 'not used' }),
      execute: async () => ({ ok: false, error: 'not used' }),
      update: async () => ({ ok: false, error: 'not used' }),
      submitStageResult: async () => ({ ok: false, error: 'not used' }),
      rollbackStage: async () => ({ ok: false, error: 'not used' }),
    })
    const core = createCoreInstance({ planRuntime: runtime })
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: 'Recovery session',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 1,
        updatedAt: 1,
      },
    })
    core.getSessionStore(sessionId).store.setter(runAtom, { runId: 'run-1', status: 'running' })
    const event = vi.spyOn(core.observability, 'addEvent')
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    })
    const ctx = buildToolContext({
      sessionId,
      runId: 'run-1',
      signal: new AbortController().signal,
      callId: 'call-1',
      toolName: 'create_plan',
      core,
    })

    await expect(ctx.createPlan!({ title: 'Resume safely', objective: 'persist before continuing', stages: [] }))
      .rejects.toThrow()
    expect(continued).toBe(false)
    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({ status: 'interrupted' })
    expect(event).toHaveBeenCalledWith('agent.plan_recovery_persistence_blocked', expect.anything())
  })
})
