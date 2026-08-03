import { activeSessionIdAtom } from '../../state/rootStore'
import { checkpointsAtom, itemsAtom, runAtom } from '../../state/sessionAtoms'
import { getPlan, setPlan } from '../../state/planWriters'
import { appendItem, setRun } from '../../state/sessionWriters'
import { pruneBrowserCardsAfter, pruneRuntimeTranscriptEventsAfter, setWithdrawnTurnNotice } from '../../state/transientAtoms'
import { revertToPlanStageCheckpoint, updateCheckpoint } from '../../state/checkpointWriters'
import { PlanRuntime } from '../../planning/runtime'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { persistCheckpoint } from '../persistenceBridge'
import { assertRunStatus, resumePausedRun } from './runCommands'
import { currentTurnHasSideEffects } from './turnSafety'

/** Builds plan approval and stage rollback commands bound to one runtime core. */
export function createPlanCommands(core: CoreInstance, stopRun: () => void) {
  function approvePlan(approved: boolean): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    const pending = run?.pendingPlanApproval
    if (!assertRunStatus(run, 'waiting_plan_approval') || !pending) return
    const runtime = new PlanRuntime({ get: () => getPlan(id, core), set: (plan) => setPlan(id, plan, core) }, Date.now, newId)
    const decision = runtime.approve(pending.planId, pending.revision, approved)
    const content = decision.ok
      ? JSON.stringify(approved ? { approved: true, plan: decision.plan } : { error: '用户拒绝了计划', plan: decision.plan })
      : JSON.stringify({ error: decision.error })
    appendItem(id, { id: newId(), createdAt: Date.now(), item: { role: 'tool', tool_call_id: pending.callId, content } }, core)
    resumePausedRun(id, run, { pendingPlanApproval: undefined }, core)
  }

  function rollbackPlanStage(planId: string, revision: number, stageId: string): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const current = getPlan(id, core)
    if (!current || current.id !== planId || current.revision !== revision) return
    if (!['active', 'completed', 'failed'].includes(current.status) ||
      !current.stages.some((stage) => stage.id === stageId && stage.status !== 'pending')) return
    const store = core.getSessionStore(id).store
    const discardedItems = store.getter(itemsAtom)
    stopRun()
    setRun(id, undefined, core)
    const point = revertToPlanStageCheckpoint(id, stageId, core)
    if (!point) {
      const runtime = new PlanRuntime({ get: () => getPlan(id, core), set: (plan) => setPlan(id, plan, core) }, Date.now, newId)
      runtime.rollbackStage(planId, revision, stageId)
      return
    }
    pruneBrowserCardsAfter(id, point.createdAt, core)
    pruneRuntimeTranscriptEventsAfter(id, point.createdAt, core)
    const working = store.getter(checkpointsAtom).at(-1)
    if (working) {
      updateCheckpoint(id, working.turnIndex, working.label, core, undefined)
      const updated = store.getter(checkpointsAtom)[working.turnIndex]
      if (updated) persistCheckpoint(id, updated)
    }
    const sideEffects = currentTurnHasSideEffects(discardedItems.slice(point.itemCount))
    setWithdrawnTurnNotice(id, {
      id: newId(), createdAt: Date.now(), sideEffects,
      text: sideEffects
        ? '已回退到该阶段开始前，该阶段之后的对话已撤回；已触发过工具，外部副作用不会被自动撤销。'
        : '已回退到该阶段开始前，该阶段之后的对话已撤回。',
    }, core)
  }

  return { approvePlan, rollbackPlanStage }
}
