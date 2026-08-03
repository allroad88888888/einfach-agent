import { planAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import type { ToolLoopBase } from './toolLoopContracts'
import { MIN_PLAN_AGENT_TURNS, persistedModelTurnsForStage } from './toolLoopPlan'

/** Stops a plan stage that exhausts its own persistent turn allowance. */
export function stopOverBudgetPlanStage(
  base: ToolLoopBase,
  persistWorkingTurn: () => void,
  stageId: string,
): boolean {
  if (stageId === base.state.guardStageId) base.state.stageTurnsOnGuard += 1
  else {
    base.state.guardStageId = stageId
    base.state.stageTurnsOnGuard = persistedModelTurnsForStage(base.id, stageId, base.core) + 1
  }
  if (base.state.stageTurnsOnGuard <= MIN_PLAN_AGENT_TURNS) return false

  const plan = base.core.getSessionStore(base.id).store.getter(planAtom)
  const stage = plan?.stages.find((entry) => entry.id === stageId)
  const error = `计划阶段「${stage?.title ?? stageId}」已连续占用超过 ${MIN_PLAN_AGENT_TURNS} 轮仍未推进到下一阶段，已暂停自动执行并交还给你。常见原因：该阶段拆得过大，或 submit_stage_result 反复被拒导致阶段无法关闭；请检查后手动继续、拆分该阶段，或修正提交参数。`
  if (base.control.isRunning()) patchRun(base.id, { status: 'error', error }, base.core)
  persistWorkingTurn()
  base.trace.finish('error', 'agent.plan_stage_over_budget', {
    planId: plan?.id,
    planStatus: plan?.status,
    stageId,
    stage_turns: base.state.stageTurnsOnGuard,
    limit: MIN_PLAN_AGENT_TURNS,
    error,
  })
  return true
}
