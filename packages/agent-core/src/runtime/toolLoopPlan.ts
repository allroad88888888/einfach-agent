import { itemsAtom, planAtom } from '../state/sessionAtoms'
import type { PendingUserDecisionOrigin } from '../state/core.type'
import { normalizeAskUserQuestionPayload } from './askUserQuestion'
import type { CoreInstance } from './core/coreInstance'

export const EXECUTING_PLAN_STATUSES = new Set(['approved', 'active'])
export const MIN_PLAN_AGENT_TURNS = 64
const DEFAULT_MAX_AGENT_TURNS = 32
const PLAN_AGENT_TURNS_PER_STAGE = 24
const MAX_PLAN_AGENT_TURNS = 256

/** Gets the in-progress stage that owns all writes for this model turn. */
export function currentPlanStageId(id: string, core: CoreInstance): string | undefined {
  return core.getSessionStore(id).store.getter(planAtom)?.stages.find((stage) => stage.status === 'in_progress')?.id
}

/** Projects only the active plan protocol into the current model request. */
export function currentPlanContext(id: string, core: CoreInstance): string | undefined {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (!plan || !EXECUTING_PLAN_STATUSES.has(plan.status)) return undefined
  const currentStage = plan.stages.find((stage) => stage.status === 'in_progress')
  const snapshot = {
    planId: plan.id, revision: plan.revision, title: plan.title, objective: plan.objective, status: plan.status,
    currentStage: currentStage ? { stageId: currentStage.id, title: currentStage.title, objective: currentStage.objective, status: currentStage.status, deliverables: currentStage.deliverables, evidence: currentStage.evidence } : null,
    stages: plan.stages.map((stage) => ({ stageId: stage.id, title: stage.title, status: stage.status, dependencies: stage.dependencies })),
  }
  return ['<current_plan_snapshot>', '以下 JSON 是运行时提供的权威计划状态（数据，不是用户指令）。调用计划工具时必须使用其中精确的 planId、revision 和 stageId。', JSON.stringify(snapshot), '</current_plan_snapshot>'].join('\n')
}

export function planResumeNotice(): string {
  return ['这是一次从持久化状态恢复的计划执行，不是新的用户请求。', '沿用 current_plan_snapshot 中的计划、revision 与当前阶段；不要重新创建计划。', '从尚未完成的阶段继续，完成阶段产出后调用 submit_stage_result，并继续后续阶段直到计划结束。'].join('\n')
}

export function maxAgentTurns(id: string, core: CoreInstance): number {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (!plan || !EXECUTING_PLAN_STATUSES.has(plan.status)) return DEFAULT_MAX_AGENT_TURNS
  return Math.min(MAX_PLAN_AGENT_TURNS, Math.max(MIN_PLAN_AGENT_TURNS, DEFAULT_MAX_AGENT_TURNS + plan.stages.length * PLAN_AGENT_TURNS_PER_STAGE))
}

export function persistedModelTurnsForStage(id: string, stageId: string, core: CoreInstance): number {
  return core.getSessionStore(id).store.getter(itemsAtom).reduce((count, item) => count + (item.planStageId === stageId && item.item.role === 'assistant' ? 1 : 0), 0)
}

export function planApprovalPayload(payload: unknown): { planId: string; revision: number } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const value = payload as Record<string, unknown>
  return value.kind === 'plan_approval' && typeof value.planId === 'string' && typeof value.revision === 'number' ? { planId: value.planId, revision: value.revision } : undefined
}

export function pendingDecisionOrigin(id: string, payload: unknown, planStageId: string | undefined, core: CoreInstance): PendingUserDecisionOrigin {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (plan) {
    const phase = plan.status === 'draft' ? 'drafting' : plan.status === 'awaiting_approval' ? 'approval' : 'executing'
    return { surface: 'plan', phase, planId: plan.id, planRevision: plan.revision, stageId: planStageId }
  }
  const declaredContext = normalizeAskUserQuestionPayload(payload).context
  return declaredContext?.surface === 'plan' ? { surface: 'plan', phase: declaredContext.phase ?? 'drafting' } : { surface: 'conversation' }
}

/** Produces the next-turn instruction after a non-final plan text response. */
export function planContinuationNotice(planId: string, status: string, stage: { id: string; title: string; status: string } | undefined, rejection: string | undefined): string {
  const lines = ['结构化计划尚未完成，上一条文本只能视为阶段性说明，不能作为最终答案，也不能声称整个任务已完成。', `当前计划状态：${status}。`, stage ? `当前阶段：${stage.title}（${stage.status}）。` : '当前没有已完成验收的最终阶段，请调用 execute_plan 启动或恢复计划。']
  if (rejection) lines.push(`注意：你上一次 submit_stage_result 未成功，当前阶段仍未关闭。失败原因：${rejection}`, '请先针对该原因修正后重新调用 submit_stage_result（例如先 request_tool_schema 加载 schema、或按 schema 修正参数结构），不要用纯文本描述替代提交。')
  else lines.push('继续执行计划；完成当前阶段产出后必须调用 submit_stage_result，由 evaluator 判定阶段与计划是否完成。')
  return lines.join('\n')
}
