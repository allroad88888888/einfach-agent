import type { PlanSnapshot } from './types'

/** Read-time, in-memory migration. Legacy completed plans remain completed and are not retroactively re-evaluated. */
export function migratePlanSnapshot(plan: PlanSnapshot): PlanSnapshot {
  if (plan.schemaVersion === 2 && plan.stages.every((stage) => Array.isArray(stage.evaluations))) return plan
  return {
    ...plan,
    schemaVersion: 2,
    stages: plan.stages.map((stage) => ({ ...stage, evaluations: stage.evaluations ?? [] })),
  }
}
