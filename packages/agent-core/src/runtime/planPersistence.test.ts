import { describe, expect, it, vi } from 'vitest'
import type { PlanRuntimeFactory, PlanSnapshot } from '../planning/types'
import { sessionsAtom } from '../state/rootStore'
import { planAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance } from './core/coreInstance'
import type { RecoveryWriteOutcome } from './recoveryWriter'
import { createPlanPersistenceAdapter } from './planPersistence'

const sessionId = 'plan-persistence-session'

function plan(): PlanSnapshot {
  return {
    schemaVersion: 4,
    id: 'plan-1',
    title: 'Persist plan',
    objective: 'wait for recovery durability',
    status: 'active',
    revision: 1,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 1,
    stages: [],
  }
}

const writePlanRuntime: PlanRuntimeFactory = (store) => ({
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

function seed(core: ReturnType<typeof createCoreInstance>, withRun = true): void {
  core.rootStore.setter(sessionsAtom, {
    [sessionId]: {
      id: sessionId,
      title: 'Persistence session',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
  if (withRun) core.getSessionStore(sessionId).store.setter(runAtom, { runId: 'run-1', status: 'running' })
}

function createRuntime(core: ReturnType<typeof createCoreInstance>, fallbackRun?: { runId: string, status: 'running' }) {
  const runtime = createPlanPersistenceAdapter(core, sessionId, fallbackRun).planRuntime
  if (!runtime) throw new Error('test runtime was not installed')
  return runtime
}

describe('createPlanPersistenceAdapter', () => {
  it('blocks the shared plan write when recovery persistence throws', async () => {
    const core = createCoreInstance({ planRuntime: writePlanRuntime })
    seed(core)
    const event = vi.spyOn(core.observability, 'addEvent')
    vi.spyOn(core.persistence, 'persistRecovery').mockRejectedValue(new Error('disk unavailable'))

    await expect(createRuntime(core).create({ title: '', objective: '', stages: [] })).rejects.toThrow('disk unavailable')

    expect(core.getSessionStore(sessionId).store.getter(planAtom)).toEqual(plan())
    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({
      status: 'interrupted', error: '恢复快照未确认：disk unavailable',
    })
    expect(event).toHaveBeenCalledWith('agent.plan_recovery_persistence_blocked', expect.objectContaining({
      attrs: expect.objectContaining({ sessionId, runId: 'run-1', reason: 'plan.stage', error: 'disk unavailable' }),
    }))
  })

  it.each([
    { status: 'error', sessionId, error: new Error('driver failed') },
    { status: 'tombstoned', sessionId },
    { status: 'skipped', sessionId, reason: 'reset' },
  ] as RecoveryWriteOutcome[])('blocks a non-saved persistence outcome: $status', async (outcome) => {
    const core = createCoreInstance({ planRuntime: writePlanRuntime })
    seed(core)
    vi.spyOn(core.persistence, 'persistRecovery').mockResolvedValue(outcome)

    await expect(createRuntime(core).create({ title: '', objective: '', stages: [] })).rejects.toThrow(`Recovery persistence returned ${outcome.status}.`)

    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({ status: 'interrupted' })
  })

  it('blocks without attempting persistence when the session disappears', async () => {
    const core = createCoreInstance({ planRuntime: writePlanRuntime })
    seed(core)
    const persist = vi.spyOn(core.persistence, 'persistRecovery')
    const runtime = createRuntime(core)
    core.rootStore.setter(sessionsAtom, {})

    await expect(runtime.create({ title: '', objective: '', stages: [] })).rejects.toThrow('Plan session is no longer available.')

    expect(persist).not.toHaveBeenCalled()
    expect(core.getSessionStore(sessionId).store.getter(planAtom)).toBeUndefined()
  })

  it('uses the fallback run to interrupt a rollback whose current run was cleared', async () => {
    const core = createCoreInstance({ planRuntime: writePlanRuntime })
    seed(core, false)
    vi.spyOn(core.persistence, 'persistRecovery').mockResolvedValue({ status: 'tombstoned', sessionId })

    await expect(createPlanPersistenceAdapter(core, sessionId, { runId: 'stopped-run', status: 'running' }).persist('plan.stage_rollback'))
      .rejects.toThrow('Recovery persistence returned tombstoned.')

    expect(core.getSessionStore(sessionId).store.getter(runAtom)).toMatchObject({
      runId: 'stopped-run', status: 'interrupted',
    })
  })
})
