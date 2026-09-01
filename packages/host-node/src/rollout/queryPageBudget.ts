import { AGENT_HISTORY_PAGE_MAX_CHARS } from '@einfach-agent/core/history'

export interface BudgetedPage<Result> {
  readonly result: Result
  readonly includedCount: number
}

/** Fits candidates by measuring the complete result envelope produced by the caller. */
export function fitQueryPage<Result>(
  candidateCount: number,
  build: (includedCount: number, truncated: boolean) => Result,
): BudgetedPage<Result> {
  const complete = build(candidateCount, false)
  if (JSON.stringify(complete).length <= AGENT_HISTORY_PAGE_MAX_CHARS) {
    return { result: complete, includedCount: candidateCount }
  }
  for (let count = candidateCount - 1; count >= 1; count -= 1) {
    const result = build(count, true)
    if (JSON.stringify(result).length <= AGENT_HISTORY_PAGE_MAX_CHARS) {
      return { result, includedCount: count }
    }
  }
  throw new RangeError(`History result cannot fit within ${AGENT_HISTORY_PAGE_MAX_CHARS} serialized characters`)
}

/** Enforces the same bound for pages with no candidate that can provide a continuation key. */
export function assertEmptyQueryPageFits<Result>(result: Result): Result {
  if (JSON.stringify(result).length > AGENT_HISTORY_PAGE_MAX_CHARS) {
    throw new RangeError(`History result identity cannot fit within ${AGENT_HISTORY_PAGE_MAX_CHARS} serialized characters`)
  }
  return result
}
