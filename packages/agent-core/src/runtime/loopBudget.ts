/** Owns the mutable turn ceiling for a run, including plan and queued-input growth. */
export interface LoopBudget {
  allows(turn: number): boolean
  limit(): number
  includeQueuedInputs(count: number): void
  syncPlanFloor(): void
}

export function createLoopBudget(initialLimit: number, planLimit: () => number): LoopBudget {
  let limit = initialLimit
  return {
    allows(turn): boolean {
      return turn < limit
    },
    limit(): number {
      return limit
    },
    includeQueuedInputs(count): void {
      limit += Math.max(1, count)
    },
    syncPlanFloor(): void {
      limit = Math.max(limit, planLimit())
    },
  }
}
