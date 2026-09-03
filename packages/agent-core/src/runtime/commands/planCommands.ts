import { activeSessionIdAtom } from '../../state/rootStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { appendItem, setRun } from '../../state/sessionWriters'
import { pruneBrowserCardsAfter, pruneRuntimeTranscriptEventsAfter, setWithdrawnTurnNotice } from '../../state/transientAtoms'
import { revertToPlanStageCheckpoint } from '../../state/planStageRewind'
import type { RunState } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { assertRunStatus, resumePausedRun } from './runCommands'
import { currentTurnHasSideEffects } from './turnSafety'
import { blockPlanPersistence, createPlanPersistenceAdapter } from '../planPersistence'

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
    blockPlanPersistence(core, id, 'plan.approval_resume', error instanceof Error ? error.message : String(error), run)
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
    const runtime = createPlanPersistenceAdapter(core, id).planRuntime
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
    const planPersistence = createPlanPersistenceAdapter(core, id)
    const initialRuntime = planPersistence.planRuntime
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
      const runtime = createPlanPersistenceAdapter(core, id, stoppedRun).planRuntime
      if (!runtime) return false
      try {
        return (await runtime.rollbackStage(planId, revision, stageId)).ok
      } catch {
        return false
      }
    }
    try {
      await planPersistence.persist('plan.stage_rollback', stoppedRun)
    } catch {
      return false
    }
    pruneBrowserCardsAfter(id, point.createdAt, core)
    pruneRuntimeTranscriptEventsAfter(id, point.createdAt, core)
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
