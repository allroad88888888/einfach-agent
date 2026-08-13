import type {
  CreatePlanInput,
  PlanMutationResult,
  PlanRuntime as PlanRuntimeContract,
  PlanRuntimeStore,
  PlanSnapshot,
  PlanStage,
  SubmitStageResultInput,
  UpdatePlanInput,
} from '@web-agent/core/planning'

function fail(error: string): PlanMutationResult {
  return { ok: false, error }
}

function nextReadyStage(stages: PlanStage[]): PlanStage | undefined {
  const completed = new Set(stages.filter((stage) => stage.status === 'completed' || stage.status === 'skipped').map((stage) => stage.id))
  return stages.find((stage) => stage.status === 'pending' && stage.dependencies.every((id) => completed.has(id)))
}

function nextRetryableStage(stages: PlanStage[]): PlanStage | undefined {
  const completed = new Set(stages.filter((stage) => stage.status === 'completed' || stage.status === 'skipped').map((stage) => stage.id))
  return stages.find((stage) => (stage.status === 'failed' || stage.status === 'blocked') && stage.dependencies.every((id) => completed.has(id)))
}

function validateStages(input: CreatePlanInput['stages']): string | undefined {
  if (!input.length) return 'plan must contain at least one stage'
  const ids = new Set<string>()
  for (const stage of input) {
    if (!stage.id.trim() || !stage.title.trim() || !stage.objective.trim()) return 'stage id, title and objective are required'
    if (ids.has(stage.id)) return `duplicate stage id: ${stage.id}`
    ids.add(stage.id)
  }
  for (const stage of input) {
    for (const dependency of stage.dependencies ?? []) {
      if (!ids.has(dependency)) return `unknown dependency ${dependency} in stage ${stage.id}`
      if (dependency === stage.id) return `stage ${stage.id} cannot depend on itself`
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(input.map((stage) => [stage.id, stage]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) if (!visit(dependency)) return false
    visiting.delete(id)
    visited.add(id)
    return true
  }
  for (const id of ids) if (!visit(id)) return 'stage dependencies must be acyclic'
  return undefined
}

export class PlanRuntime implements PlanRuntimeContract {
  constructor(
    private readonly store: PlanRuntimeStore,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  get(): PlanSnapshot | undefined {
    return this.store.get()
  }

  create(input: CreatePlanInput): PlanMutationResult {
    if (!input.title.trim() || !input.objective.trim()) return fail('plan title and objective are required')
    const invalid = validateStages(input.stages)
    if (invalid) return fail(invalid)
    const createdAt = this.now()
    const requiresApproval = input.approvalMode === 'required'
    const plan: PlanSnapshot = {
      schemaVersion: 4,
      id: this.id(),
      title: input.title.trim(),
      objective: input.objective.trim(),
      status: requiresApproval ? 'awaiting_approval' : 'approved',
      revision: 1,
      requiresApproval,
      createdAt,
      updatedAt: createdAt,
      stages: input.stages.map((stage) => ({
        id: stage.id,
        title: stage.title.trim(),
        objective: stage.objective.trim(),
        deliverables: stage.deliverables ?? [],
        dependencies: stage.dependencies ?? [],
        status: 'pending',
        evidence: [],
        evaluations: [],
      })),
    }
    this.store.set(plan)
    return { ok: true, plan }
  }

  approve(planId: string, revision: number, approved: boolean): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, planId, revision)
    if (error) return fail(error)
    if (current!.status !== 'awaiting_approval') return fail(`plan is ${current!.status}, not awaiting approval`)
    return this.write({ ...current!, status: approved ? 'approved' : 'cancelled' })
  }

  execute(planId: string, revision: number): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, planId, revision)
    if (error) return fail(error)
    if (current!.status !== 'approved' && current!.status !== 'active') return fail(`plan is ${current!.status}, approval is required before execution`)
    if (current!.stages.some((stage) => stage.status === 'in_progress')) return { ok: true, plan: current! }
    const next = nextRetryableStage(current!.stages) ?? nextReadyStage(current!.stages)
    if (!next) return fail('plan has no ready stage')
    return this.write({
      ...current!,
      status: 'active',
      stages: current!.stages.map((stage) => stage.id === next.id ? { ...stage, status: 'in_progress' } : stage),
    })
  }

  update(input: UpdatePlanInput): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, input.planId, input.revision)
    if (error) return fail(error)
    if (current!.status !== 'active') return fail(`plan is ${current!.status}, not active`)
    const target = current!.stages.find((stage) => stage.id === input.stageId)
    if (!target) return fail(`unknown stage: ${input.stageId}`)
    if (target.status !== 'in_progress') return fail(`stage ${input.stageId} is ${target.status}, not in_progress`)
    if (input.status !== 'blocked') return fail('completing a stage requires submit_stage_result')
    if (!input.blockReason?.trim()) return fail('blocked stage requires blockReason')

    return this.write({
      ...current!,
      status: 'active',
      stages: current!.stages.map((stage) => stage.id === input.stageId ? {
        ...stage,
        status: input.status,
        evidence: [...stage.evidence, ...(input.evidence ?? [])],
        blockReason: input.blockReason!.trim(),
      } : stage),
    })
  }

  /**
   * 提交阶段产出并完成该阶段，随后激活下一个依赖就绪的阶段。
   *
   * summary 与 evidence 是强制留痕：阶段完成没有第三方判定，产出至少要留下可回看的记录，
   * 否则计划面板上只剩一串「已完成」，无从判断当时到底做了什么。
   */
  submitStageResult(input: SubmitStageResultInput): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, input.planId, input.revision)
    if (error) return fail(error)
    if (current!.status !== 'active') return fail(`plan is ${current!.status}, not active`)
    const target = current!.stages.find((stage) => stage.id === input.stageId)
    if (!target) return fail(`unknown stage: ${input.stageId}`)
    if (target.status !== 'in_progress') return fail(`stage ${input.stageId} is ${target.status}, not in_progress`)
    const summary = input.summary.trim()
    if (!summary) return fail('stage result requires summary')
    const evidence = input.evidence.map((item) => item.trim()).filter(Boolean)
    if (!evidence.length) return fail('stage result requires evidence')

    let stages = current!.stages.map((stage) => stage.id === input.stageId ? {
      ...stage,
      status: 'completed' as const,
      evidence: [...stage.evidence, ...evidence],
      blockReason: undefined,
      result: { summary, evidence, submittedAt: this.now() },
    } : stage)
    const terminal = stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')
    if (!terminal) {
      const next = nextReadyStage(stages)
      if (next) stages = stages.map((stage) => stage.id === next.id ? { ...stage, status: 'in_progress' as const } : stage)
    }
    return this.write({ ...current!, status: terminal ? 'completed' : 'active', stages })
  }

  /**
   * 将指定阶段及所有依赖它的后续阶段重新打开。
   *
   * 已完成的前置阶段保持不变；被回滚的阶段会丢弃旧的执行证据和产出记录，
   * 由宿主在下一次 continuePlan 时从目标阶段重新执行。
   */
  rollbackStage(planId: string, revision: number, stageId: string): PlanMutationResult {
    const current = this.store.get()
    const error = this.guard(current, planId, revision)
    if (error) return fail(error)
    if (!['active', 'completed', 'failed'].includes(current!.status)) {
      return fail(`plan is ${current!.status}, no executed stage can be rolled back`)
    }

    const target = current!.stages.find((stage) => stage.id === stageId)
    if (!target) return fail(`unknown stage: ${stageId}`)
    if (target.status === 'pending') return fail(`stage ${stageId} has not started`)

    const rolledBack = new Set<string>([stageId])
    let changed = true
    while (changed) {
      changed = false
      for (const stage of current!.stages) {
        if (rolledBack.has(stage.id) || !stage.dependencies.some((dependency) => rolledBack.has(dependency))) continue
        rolledBack.add(stage.id)
        changed = true
      }
    }

    return this.write({
      ...current!,
      status: 'active',
      stages: current!.stages.map((stage) => {
        if (!rolledBack.has(stage.id)) return stage
        return {
          ...stage,
          status: stage.id === stageId ? 'in_progress' : 'pending',
          evidence: [],
          result: undefined,
          blockReason: undefined,
        }
      }),
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

export function createDefaultPlanRuntime(store: PlanRuntimeStore): PlanRuntimeContract {
  return new PlanRuntime(store)
}
