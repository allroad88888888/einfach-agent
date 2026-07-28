import type {
  CriterionEvaluation,
  EvaluatePlanInput,
  EvaluateStageInput,
  EvaluationVerdict,
  PlanMutationResult,
  PlanSnapshot,
  PlanStage,
  SubmitStageResultInput,
} from '../planning/types'

export interface EvaluationRuntimeStore {
  get(): PlanSnapshot | undefined
  set(plan: PlanSnapshot | undefined): void
}

function fail(error: string): PlanMutationResult {
  return { ok: false, error }
}

function completedIds(stages: PlanStage[]): Set<string> {
  return new Set(stages.filter((stage) => stage.status === 'completed' || stage.status === 'skipped').map((stage) => stage.id))
}

function nextReadyStage(stages: PlanStage[]): PlanStage | undefined {
  const completed = completedIds(stages)
  return stages.find((stage) => stage.status === 'pending' && stage.dependencies.every((id) => completed.has(id)))
}

function criterionError(expected: string[], actual: CriterionEvaluation[]): string | undefined {
  if (actual.length !== expected.length) return 'evaluation must cover every acceptance criterion exactly once'
  const seen = new Set<string>()
  for (const result of actual) {
    if (!expected.includes(result.criterion)) return `unknown acceptance criterion: ${result.criterion}`
    if (seen.has(result.criterion)) return `duplicate acceptance criterion: ${result.criterion}`
    seen.add(result.criterion)
    if (result.status === 'passed' && !result.evidence.some((item) => item.trim())) {
      return `passed criterion requires evidence: ${result.criterion}`
    }
    if (result.status !== 'passed' && !result.reason.trim()) {
      return `${result.status} criterion requires reason: ${result.criterion}`
    }
  }
  return expected.some((criterion) => !seen.has(criterion))
    ? 'evaluation must cover every acceptance criterion exactly once'
    : undefined
}

function stageVerdict(criteria: CriterionEvaluation[]): EvaluationVerdict {
  if (criteria.some((item) => item.status === 'failed')) return 'failed'
  if (criteria.some((item) => item.status === 'unknown')) return 'unknown'
  return 'passed'
}

/**
 * unknown 不是「不合格」，而是「没法判定」—— 阶段落 blocked 而不是 failed，理由必须可读，
 * 否则 UI 和模型都只看到一个空的 blocked，无从判断该重试还是该交给用户裁定。
 */
function unknownBlockReason(criteria: CriterionEvaluation[]): string {
  const reasons = criteria
    .filter((item) => item.status === 'unknown')
    .map((item) => item.reason.trim())
    .filter(Boolean)
  return reasons.slice(0, 3).join('; ') || 'evaluation could not verify acceptance criteria'
}

export class EvaluationRuntime {
  constructor(
    private readonly store: EvaluationRuntimeStore,
    private readonly now: () => number = Date.now,
  ) {}

  submitStageResult(input: SubmitStageResultInput): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, input.planId, input.revision)
    if (error) return fail(error)
    if (current!.status !== 'active') return fail(`plan is ${current!.status}, not active`)
    const target = current!.stages.find((stage) => stage.id === input.stageId)
    if (!target) return fail(`unknown stage: ${input.stageId}`)
    if (target.status !== 'in_progress') return fail(`stage ${input.stageId} is ${target.status}, not in_progress`)
    if (!input.summary.trim()) return fail('stage result requires summary')
    const submittedEvidence = input.evidence.map((item) => item.trim()).filter(Boolean)
    if (!submittedEvidence.length) return fail('stage result requires evidence')
    const evaluations = target.evaluations ?? []
    return this.write({
      ...current!,
      stages: current!.stages.map((stage) => stage.id === input.stageId ? {
        ...stage,
        status: 'evaluating',
        evidence: [...stage.evidence, ...submittedEvidence],
        blockReason: undefined,
        evaluations: [...evaluations, {
          attempt: evaluations.length + 1,
          status: 'evaluating',
          summary: input.summary.trim(),
          submittedEvidence,
          criteria: [],
          submittedAt: this.now(),
        }],
      } : stage),
    })
  }

  evaluateStage(input: EvaluateStageInput): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, input.planId, input.revision)
    if (error) return fail(error)
    if (current!.status !== 'active') return fail(`plan is ${current!.status}, not active`)
    const target = current!.stages.find((stage) => stage.id === input.stageId)
    if (!target) return fail(`unknown stage: ${input.stageId}`)
    if (target.status !== 'evaluating') return fail(`stage ${input.stageId} is ${target.status}, not evaluating`)
    const invalid = criterionError(target.acceptanceCriteria, input.criteria)
    if (invalid) return fail(invalid)
    const verdict = stageVerdict(input.criteria)
    const attempts = target.evaluations ?? []
    const latest = attempts.at(-1)
    if (!latest || latest.status !== 'evaluating') return fail('stage has no submitted result to evaluate')
    // failed = 判定不合格，blocked = 判定不了（评估器够不着的验收标准）。两者都不解锁依赖、
    // 两种状态都不解锁依赖，但都能被 execute_plan 重新拉起。
    const stageStatus = verdict === 'passed' ? 'completed' as const : verdict === 'failed' ? 'failed' as const : 'blocked' as const
    let stages = current!.stages.map((stage) => stage.id === input.stageId ? {
      ...stage,
      status: stageStatus,
      blockReason: verdict === 'unknown' ? unknownBlockReason(input.criteria) : undefined,
      evaluations: attempts.map((attempt, index) => index === attempts.length - 1 ? {
        ...attempt,
        status: verdict,
        criteria: input.criteria.map((item) => ({
          ...item,
          evidence: item.evidence.map((evidence) => evidence.trim()).filter(Boolean),
          reason: item.reason.trim(),
        })),
        evaluatedAt: this.now(),
      } : attempt),
    } : stage)

    let status: PlanSnapshot['status'] = current!.status
    if (verdict === 'passed') {
      const terminal = stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')
      status = terminal ? 'evaluating' : 'active'
      if (!terminal) {
        const next = nextReadyStage(stages)
        if (next) stages = stages.map((stage) => stage.id === next.id ? { ...stage, status: 'in_progress' } : stage)
      }
    }
    return this.write({ ...current!, status, stages })
  }

  abortStageEvaluation(planId: string, revision: number, stageId: string, reason: string): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, planId, revision)
    if (error) return fail(error)
    const target = current!.stages.find((stage) => stage.id === stageId)
    if (!target) return fail(`unknown stage: ${stageId}`)
    if (target.status !== 'evaluating') return fail(`stage ${stageId} is ${target.status}, not evaluating`)
    const attempts = target.evaluations ?? []
    const latest = attempts.at(-1)
    return this.write({
      ...current!,
      stages: current!.stages.map((stage) => stage.id === stageId ? {
        ...stage,
        status: 'in_progress',
        evaluations: attempts.map((attempt, index) => index === attempts.length - 1 ? {
          ...attempt,
          status: 'unknown',
          criteria: stage.acceptanceCriteria.map((criterion) => ({
            criterion,
            status: 'unknown',
            evidence: [],
            reason: reason.trim() || 'evaluation unavailable',
          })),
          evaluatedAt: this.now(),
        } : attempt),
      } : stage),
    })
  }

  evaluatePlan(input: EvaluatePlanInput): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, input.planId, input.revision)
    if (error) return fail(error)
    if (current!.status !== 'evaluating') return fail(`plan is ${current!.status}, not evaluating`)
    if (!current!.stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')) {
      return fail('all stages must be completed or skipped before final evaluation')
    }
    const evidence = (input.evidence ?? []).map((item) => item.trim()).filter(Boolean)
    const reason = input.reason?.trim() ?? ''
    if (input.status === 'passed' && !evidence.length) return fail('passed plan evaluation requires evidence')
    if (input.status !== 'passed' && !reason) return fail(`${input.status} plan evaluation requires reason`)
    const requiresUserAcceptance = input.status === 'passed' && input.requiresUserAcceptance === true
    return this.write({
      ...current!,
      status: input.status === 'passed'
        ? (requiresUserAcceptance ? 'awaiting_user_acceptance' : 'completed')
        : 'failed',
      evaluation: {
        status: input.status,
        evidence,
        reason,
        evaluatedAt: this.now(),
        requiresUserAcceptance,
      },
    })
  }

  acceptPlan(planId: string, revision: number, accepted: boolean): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, planId, revision)
    if (error) return fail(error)
    if (current!.status !== 'awaiting_user_acceptance') return fail(`plan is ${current!.status}, not awaiting user acceptance`)
    return this.write({
      ...current!,
      status: accepted ? 'completed' : 'rejected',
      userAcceptance: { status: accepted ? 'accepted' : 'rejected', decidedAt: this.now() },
    })
  }

  private guard(current: PlanSnapshot | undefined, planId: string, revision: number): string | undefined {
    if (!current) return 'no plan exists'
    if (current.id !== planId) return `plan id mismatch: active plan is ${current.id}`
    if (current.revision !== revision) return `revision conflict: expected ${current.revision}, received ${revision}`
    return undefined
  }

  private write(plan: PlanSnapshot): PlanMutationResult {
    const next = { ...plan, revision: plan.revision + 1, updatedAt: this.now() }
    this.store.set(next)
    return { ok: true, plan: next }
  }
}
