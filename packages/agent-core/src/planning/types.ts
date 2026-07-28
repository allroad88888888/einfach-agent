export type PlanStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type PlanStageStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped'

/** 阶段完成时留下的产出记录。多次提交只保留最后一次。 */
export interface StageResult {
  summary: string
  evidence: string[]
  submittedAt: number
}

export interface PlanStage {
  id: string
  title: string
  objective: string
  deliverables: string[]
  dependencies: string[]
  status: PlanStageStatus
  evidence: string[]
  /** 仅在阶段被 submit_stage_result 完成后存在。 */
  result?: StageResult
  blockReason?: string
}

export interface PlanSnapshot {
  /** v4 removes host-run evaluation; optional only for legacy persisted data. */
  schemaVersion?: 4
  id: string
  title: string
  objective: string
  status: PlanStatus
  revision: number
  requiresApproval: boolean
  createdAt: number
  updatedAt: number
  stages: PlanStage[]
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

export type PlanMutationResult =
  | { ok: true; plan: PlanSnapshot }
  | { ok: false; error: string }
