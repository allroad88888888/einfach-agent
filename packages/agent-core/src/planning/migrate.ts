import type { PlanSnapshot, PlanStage, PlanStatus, StageResult } from './types'

/** v3 及更早的持久化形态：宿主跑独立评估者，阶段完成由评估结论决定。 */
interface LegacyAttempt {
  summary?: string
  submittedEvidence?: string[]
  submittedAt?: number
}

type LegacyStage = Omit<PlanStage, 'status'> & {
  status: PlanStage['status'] | 'evaluating'
  acceptanceCriteria?: string[]
  evaluations?: LegacyAttempt[]
}

type LegacyPlanSnapshot = Omit<PlanSnapshot, 'schemaVersion' | 'status' | 'stages'> & {
  schemaVersion?: number
  status: PlanStatus | 'evaluating' | 'awaiting_user_acceptance' | 'rejected'
  stages: LegacyStage[]
  evaluation?: unknown
  userAcceptance?: { status: 'accepted' | 'rejected'; decidedAt: number }
}

/**
 * Read-time, in-memory migration. Legacy completed plans remain completed and are not
 * retroactively re-opened.
 *
 * v4 移除了宿主评估：`evaluating` 不再是可停留的状态，评估结论和用户验收记录一并丢弃。
 * 中断在评估中的阶段回落 `in_progress` 而不是 `completed` —— 当时并没有人确认它做完了，
 * 直接判完成会把一个未验证的阶段永久标成已完成。
 */
export function migratePlanSnapshot(plan: PlanSnapshot): PlanSnapshot {
  const legacy = plan as LegacyPlanSnapshot
  if (legacy.schemaVersion === 4) return plan
  const {
    evaluation: _evaluation,
    userAcceptance,
    ...rest
  } = legacy
  return {
    ...rest,
    schemaVersion: 4,
    status: migrateStatus(legacy.status, userAcceptance),
    stages: legacy.stages.map(({ acceptanceCriteria: _acceptanceCriteria, evaluations, ...stage }) => ({
      ...stage,
      status: stage.status === 'evaluating' ? 'in_progress' : stage.status,
      result: stage.result ?? foldResult(evaluations),
    })),
  }
}

/**
 * 旧的 `awaiting_user_acceptance` 是「阶段全做完、等人点头」。用户已经点过接受/拒绝的按最终
 * 决定落地；还没点的按完成处理 —— v4 里没有等待验收这一档，继续挂着只会变成一个永远不会
 * 被推进的僵局。
 */
function migrateStatus(
  status: LegacyPlanSnapshot['status'],
  userAcceptance: LegacyPlanSnapshot['userAcceptance'],
): PlanStatus {
  if (status === 'evaluating') return 'active'
  if (status === 'rejected') return 'failed'
  if (status === 'awaiting_user_acceptance') return userAcceptance?.status === 'rejected' ? 'failed' : 'completed'
  return status
}

/** 最后一次提交的摘要和证据是阶段产出的唯一留痕，评估结论丢弃后仍要保住它。 */
function foldResult(evaluations: LegacyAttempt[] | undefined): StageResult | undefined {
  const latest = evaluations?.at(-1)
  if (!latest?.summary) return undefined
  return {
    summary: latest.summary,
    evidence: latest.submittedEvidence ?? [],
    submittedAt: latest.submittedAt ?? 0,
  }
}
