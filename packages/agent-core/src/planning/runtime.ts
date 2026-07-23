import type {
  CreatePlanInput,
  PlanMutationResult,
  PlanSnapshot,
  PlanStage,
  UpdatePlanInput,
} from './types'

export interface PlanRuntimeStore {
  get(): PlanSnapshot | undefined
  set(plan: PlanSnapshot | undefined): void
}

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
    if (!stage.acceptanceCriteria.length) return `stage ${stage.id} needs acceptance criteria`
    if (new Set(stage.acceptanceCriteria).size !== stage.acceptanceCriteria.length) return `stage ${stage.id} has duplicate acceptance criteria`
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

export class PlanRuntime {
  constructor(
    private readonly store: PlanRuntimeStore,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}

  create(input: CreatePlanInput): PlanMutationResult {
    if (!input.title.trim() || !input.objective.trim()) return fail('plan title and objective are required')
    const invalid = validateStages(input.stages)
    if (invalid) return fail(invalid)
    const createdAt = this.now()
    const requiresApproval = input.approvalMode === 'required'
    const plan: PlanSnapshot = {
      schemaVersion: 2,
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
        acceptanceCriteria: stage.acceptanceCriteria,
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
    if (current!.stages.some((stage) => stage.status === 'in_progress' || stage.status === 'evaluating')) return { ok: true, plan: current! }
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
    if (input.status !== 'blocked') return fail('completion and skipping require host evaluation')
    if (input.status === 'blocked' && !input.blockReason?.trim()) return fail('blocked stage requires blockReason')

    let stages = current!.stages.map((stage) => stage.id === input.stageId ? {
      ...stage,
      status: input.status,
      evidence: [...stage.evidence, ...(input.evidence ?? [])],
      blockReason: input.status === 'blocked' ? input.blockReason!.trim() : undefined,
    } : stage)
    const terminal = stages.every((stage) => stage.status === 'completed' || stage.status === 'skipped')
    return this.write({ ...current!, status: terminal ? 'evaluating' : 'active', stages })
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
