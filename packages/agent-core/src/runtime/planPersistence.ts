import type { PlanRuntime } from '../planning/types'
import type { RunState } from '../state/core.type'
import { sessionsAtom } from '../state/rootStore'
import { runAtom } from '../state/sessionAtoms'
import { getPlan, setPlan } from '../state/planWriters'
import { setRun } from '../state/sessionWriters'
import type { CoreInstance } from './core/coreInstance'

export interface PlanPersistenceAdapter {
  planRuntime: PlanRuntime | undefined
  persist(reason: string, fallbackRun?: RunState): Promise<void>
}

function withoutUndefined(run: RunState): RunState {
  return Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)) as RunState
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function blockPlanPersistence(
  core: CoreInstance,
  sessionId: string,
  reason: string,
  error: string,
  fallbackRun?: RunState,
): Error {
  const run = core.findSessionStore(sessionId)?.store.getter(runAtom) ?? fallbackRun
  if (run && core.rootStore.getter(sessionsAtom)[sessionId]) {
    setRun(sessionId, withoutUndefined({
      ...run,
      status: 'interrupted',
      error: `恢复快照未确认：${error}`,
    }), core)
  }
  core.observability.addEvent('agent.plan_recovery_persistence_blocked', {
    attrs: {
      sessionId,
      ...(run ? { runId: run.runId } : {}),
      reason,
      error,
    },
  })
  return new Error(error)
}

/** Binds one optional PlanRuntime to a session store behind a recovery durability barrier. */
export function createPlanPersistenceAdapter(
  core: CoreInstance,
  sessionId: string,
  fallbackRun?: RunState,
): PlanPersistenceAdapter {
  async function persist(reason: string, fallback = fallbackRun): Promise<void> {
    let outcome
    try {
      outcome = await core.persistence.persistRecovery(sessionId, reason)
    } catch (error) {
      throw blockPlanPersistence(core, sessionId, reason, errorMessage(error), fallback)
    }
    if (outcome === undefined || outcome.status === 'saved') return
    throw blockPlanPersistence(core, sessionId, reason, `Recovery persistence returned ${outcome.status}.`, fallback)
  }

  const planRuntime = core.planRuntime?.({
    get: () => getPlan(sessionId, core),
    set: async (plan) => {
      if (!core.rootStore.getter(sessionsAtom)[sessionId]) {
        throw blockPlanPersistence(core, sessionId, 'plan.stage', 'Plan session is no longer available.', fallbackRun)
      }
      setPlan(sessionId, plan, core)
      await persist('plan.stage')
    },
  })

  return { planRuntime, persist }
}
