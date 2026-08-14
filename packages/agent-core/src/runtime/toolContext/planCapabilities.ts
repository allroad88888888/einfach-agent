// runtime/toolContext/planCapabilities.ts —— ctx 上的结构化计划能力。
// 状态由宿主注入的 PlanRuntime 持有（core.planRuntime 槽），工具不得直接读写 plan atom；
// 每个入口都先 assertFresh，逐字沿用拆分前 buildToolContext 里的实现。宿主未注入 runtime 时
// 整组能力缺席（不是挂个 undefined），工具据此判「计划能力不可用」。

import type { ToolContext } from '../../tools/types'
import { getPlan as readStoredPlan, setPlan } from '../../state/planWriters'
import type { RunState } from '../../state/core.type'
import { sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import { setRun } from '../../state/sessionWriters'
import type { CoreInstance } from '../core/coreInstance'
import type { ToolStaleGuards } from './staleGuards'

export type PlanCapabilities = Pick<
  ToolContext,
  'getPlan' | 'createPlan' | 'executePlan' | 'updatePlan' | 'submitStageResult'
>

function withoutUndefined(run: RunState): RunState {
  return Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)) as RunState
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failPlanPersistence(
  core: CoreInstance,
  sessionId: string,
  reason: string,
  error: string,
): Error {
  const run = core.findSessionStore(sessionId)?.store.getter(runAtom)
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

async function persistPlanStage(core: CoreInstance, sessionId: string, reason: string): Promise<void> {
  let outcome
  try {
    outcome = await core.persistence.persistRecovery(sessionId, reason)
  } catch (error) {
    throw failPlanPersistence(core, sessionId, reason, errorMessage(error))
  }
  if (outcome === undefined || outcome.status === 'saved') return
  throw failPlanPersistence(core, sessionId, reason, `Recovery persistence returned ${outcome.status}.`)
}

export function createPlanCapabilities(deps: {
  sessionId: string
  core: CoreInstance
  guards: ToolStaleGuards
}): PlanCapabilities {
  const { sessionId, core } = deps
  const { assertFresh } = deps.guards
  const planRuntime = core.planRuntime?.({
    get: () => readStoredPlan(sessionId, core),
    set: async (plan) => {
      if (!core.rootStore.getter(sessionsAtom)[sessionId]) {
        throw failPlanPersistence(core, sessionId, 'plan.stage', 'Plan session is no longer available.')
      }
      setPlan(sessionId, plan, core)
      await persistPlanStage(core, sessionId, 'plan.stage')
    },
  })

  return planRuntime ? {
    getPlan() {
      assertFresh()
      return planRuntime.get()
    },
    async createPlan(input) {
      assertFresh()
      return await planRuntime.create(input)
    },
    async executePlan(planId, revision) {
      assertFresh()
      return await planRuntime.execute(planId, revision)
    },
    async updatePlan(input) {
      assertFresh()
      return await planRuntime.update(input)
    },
    async submitStageResult(input) {
      assertFresh()
      return await planRuntime.submitStageResult(input)
    },
  } : {}
}
