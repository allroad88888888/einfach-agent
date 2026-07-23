export type PlanStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'active'
  | 'evaluating'
  | 'awaiting_user_acceptance'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'

export type PlanStageStatus = 'pending' | 'in_progress' | 'evaluating' | 'completed' | 'failed' | 'blocked' | 'skipped'

export type EvaluationVerdict = 'passed' | 'failed' | 'unknown'

export interface CriterionEvaluation {
  criterion: string
  status: EvaluationVerdict
  evidence: string[]
  reason: string
}

export interface StageEvaluationAttempt {
  attempt: number
  status: 'evaluating' | EvaluationVerdict
  summary: string
  submittedEvidence: string[]
  criteria: CriterionEvaluation[]
  submittedAt: number
  evaluatedAt?: number
}

export interface PlanEvaluation {
  status: EvaluationVerdict
  evidence: string[]
  reason: string
  evaluatedAt: number
  requiresUserAcceptance: boolean
}

export interface PlanStage {
  id: string
  title: string
  objective: string
  deliverables: string[]
  acceptanceCriteria: string[]
  dependencies: string[]
  status: PlanStageStatus
  evidence: string[]
  /** 可选以兼容 Evaluation 上线前已持久化的计划。 */
  evaluations?: StageEvaluationAttempt[]
  blockReason?: string
}

export interface PlanSnapshot {
  /** v2 introduces evaluator-owned completion records; optional only for legacy persisted data. */
  schemaVersion?: 2
  id: string
  title: string
  objective: string
  status: PlanStatus
  revision: number
  requiresApproval: boolean
  createdAt: number
  updatedAt: number
  stages: PlanStage[]
  evaluation?: PlanEvaluation
  userAcceptance?: { status: 'accepted' | 'rejected'; decidedAt: number }
}

export interface CreatePlanInput {
  title: string
  objective: string
  approvalMode?: 'auto' | 'required'
  stages: Array<{
    id: string
    title: string
    objective: string
    deliverables?: string[]
    acceptanceCriteria: string[]
    dependencies?: string[]
  }>
}

export interface UpdatePlanInput {
  planId: string
  revision: number
  stageId: string
  status: Extract<PlanStageStatus, 'blocked'>
  evidence?: string[]
  blockReason?: string
}

export interface SubmitStageResultInput {
  planId: string
  revision: number
  stageId: string
  summary: string
  evidence: string[]
}

export interface EvaluateStageInput {
  planId: string
  revision: number
  stageId: string
  criteria: CriterionEvaluation[]
}

export interface EvaluatePlanInput {
  planId: string
  revision: number
  status: EvaluationVerdict
  evidence?: string[]
  reason?: string
  requiresUserAcceptance?: boolean
}

export type PlanMutationResult =
  | { ok: true; plan: PlanSnapshot }
  | { ok: false; error: string }
