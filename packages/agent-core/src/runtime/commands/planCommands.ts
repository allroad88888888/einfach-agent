import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { checkpointsAtom, itemsAtom, runAtom } from '../../state/sessionAtoms'
import { getPlan, setPlan } from '../../state/planWriters'
import { appendItem, setRun } from '../../state/sessionWriters'
import { pruneBrowserCardsAfter, pruneRuntimeTranscriptEventsAfter, setWithdrawnTurnNotice } from '../../state/transientAtoms'
import { revertToPlanStageCheckpoint, updateCheckpoint } from '../../state/checkpointWriters'
import type { RunState } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { assertRunStatus, resumePausedRun } from './runCommands'
import { currentTurnHasSideEffects } from './turnSafety'

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

async function persistPlanStage(
  core: CoreInstance,
  sessionId: string,
  reason: string,
  fallbackRun?: RunState,
): Promise<void> {
  let outcome
  try {
    outcome = await core.persistence.persistRecovery(sessionId, reason)
  } catch (error) {
    throw failPlanPersistence(core, sessionId, reason, errorMessage(error), fallbackRun)
  }
  if (outcome === undefined || outcome.status === 'saved') return
  throw failPlanPersistence(core, sessionId, reason, `Recovery persistence returned ${outcome.status}.`, fallbackRun)
}

function planRuntimeFor(core: CoreInstance, sessionId: string, fallbackRun?: RunState) {
  return core.planRuntime?.({
    get: () => getPlan(sessionId, core),
    set: async (plan) => {
      if (!core.rootStore.getter(sessionsAtom)[sessionId]) {
        throw failPlanPersistence(core, sessionId, 'plan.stage', 'Plan session is no longer available.', fallbackRun)
      }
      setPlan(sessionId, plan, core)
      await persistPlanStage(core, sessionId, 'plan.stage', fallbackRun)
    },
  })
}

function appendPlanRuntimeUnavailable(sessionId: string, core: CoreInstance, action: string): void {
  appendItem(sessionId, {
    id: newId(),
    createdAt: Date.now(),
    item: { role: 'assistant', content: `当前运行环境未装配计划能力，无法${action}。` },
  }, core)
}

async function resumePlanApproval(id: string, run: RunState, core: CoreInstance): Promise<boolean> {
  try {
    await resumePausedRun(id, run, { pendingPlanApproval: undefined }, core)
    return true
  } catch (error) {
    failPlanPersistence(core, id, 'plan.approval_resume', errorMessage(error), run)
    return false
  }
}

/** Builds plan approval and stage rollback commands bound to one runtime core. */
export function createPlanCommands(core: CoreInstance, stopRun: () => void) {
  async function approvePlan(approved: boolean): Promise<boolean> {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return false
    const run = core.getSessionStore(id).store.getter(runAtom)
    const pending = run?.pendingPlanApproval
    if (!assertRunStatus(run, 'waiting_plan_approval') || !pending) return false
    const runtime = planRuntimeFor(core, id)
    if (!runtime) {
      appendItem(id, {
        id: newId(),
        createdAt: Date.now(),
        item: {
          role: 'tool',
          tool_call_id: pending.callId,
          content: JSON.stringify({ error: '当前运行环境未装配计划能力，无法审批计划。' }),
        },
      }, core)
      return resumePlanApproval(id, run, core)
    }
    let decision
    try {
      decision = await runtime.approve(pending.planId, pending.revision, approved)
    } catch {
      return false
    }
    const content = decision.ok
      ? JSON.stringify(approved ? { approved: true, plan: decision.plan } : { error: '用户拒绝了计划', plan: decision.plan })
      : JSON.stringify({ error: decision.error })
    appendItem(id, { id: newId(), createdAt: Date.now(), item: { role: 'tool', tool_call_id: pending.callId, content } }, core)
    return resumePlanApproval(id, run, core)
  }

  async function rollbackPlanStage(planId: string, revision: number, stageId: string): Promise<boolean> {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return false
    const initialRuntime = planRuntimeFor(core, id)
    if (!initialRuntime) {
      appendPlanRuntimeUnavailable(id, core, '回退计划阶段')
      return false
    }
    const current = initialRuntime.get()
    if (!current || current.id !== planId || current.revision !== revision) return false
    if (!['active', 'completed', 'failed'].includes(current.status) ||
      !current.stages.some((stage) => stage.id === stageId && stage.status !== 'pending')) return false
    const store = core.getSessionStore(id).store
    const discardedItems = store.getter(itemsAtom)
    stopRun()
    const stoppedRun = store.getter(runAtom)
    setRun(id, undefined, core)
    const point = revertToPlanStageCheckpoint(id, stageId, core)
    if (!point) {
      const runtime = planRuntimeFor(core, id, stoppedRun)
      if (!runtime) return false
      try {
        return (await runtime.rollbackStage(planId, revision, stageId)).ok
      } catch {
        return false
      }
    }
    try {
      await persistPlanStage(core, id, 'plan.stage_rollback', stoppedRun)
    } catch {
      return false
    }
    pruneBrowserCardsAfter(id, point.createdAt, core)
    pruneRuntimeTranscriptEventsAfter(id, point.createdAt, core)
    const working = store.getter(checkpointsAtom).at(-1)
    if (working) {
      updateCheckpoint(id, working.turnIndex, working.label, core)
      const updated = store.getter(checkpointsAtom)[working.turnIndex]
      if (updated) core.persistence.persistCheckpoint(id, updated)
    }
    const sideEffects = currentTurnHasSideEffects(discardedItems.slice(point.itemCount))
    setWithdrawnTurnNotice(id, {
      id: newId(), createdAt: Date.now(), sideEffects,
      text: sideEffects
        ? '已回退到该阶段开始前，该阶段之后的对话已撤回；已触发过工具，外部副作用不会被自动撤销。'
        : '已回退到该阶段开始前，该阶段之后的对话已撤回。',
    }, core)
    return true
  }

  return { approvePlan, rollbackPlanStage }
}
