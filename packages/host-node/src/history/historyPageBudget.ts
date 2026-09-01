import { AGENT_HISTORY_PAGE_MAX_CHARS } from '@einfach-agent/core/history'

export function fitHistoryPage<T>(values: readonly T[], build: (count: number, truncated: boolean) => unknown): number {
  for (let count = values.length; count >= 1; count -= 1) {
    if (JSON.stringify(build(count, count < values.length)).length <= AGENT_HISTORY_PAGE_MAX_CHARS) return count
  }
  if (!values.length && JSON.stringify(build(0, false)).length <= AGENT_HISTORY_PAGE_MAX_CHARS) return 0
  throw new RangeError('A history page item cannot fit within the serialized output limit')
}
export function assertHistoryEnvelope(value: unknown): void {
  if (JSON.stringify(value).length > AGENT_HISTORY_PAGE_MAX_CHARS) {
    throw new RangeError('History result cannot fit within the serialized output limit')
  }
}
