import { AGENT_HISTORY_PAGE_MAX_CHARS, type AgentHistoryWarning } from '@einfach-agent/core/history'

const OUTPUT: AgentHistoryWarning = {
  code: 'OUTPUT_TRUNCATED', message: 'History page was truncated after service warnings were added',
}
interface WarningResult { readonly warnings: readonly AgentHistoryWarning[] }

/** Re-queries a canonical page at a smaller source limit so its native cursor remains exact. */
export async function fitCanonicalWarnings<Result extends WarningResult>(
  initial: Result,
  valueCount: (result: Result) => number,
  query: (limit: number) => Promise<Result>,
  baseWarnings: readonly AgentHistoryWarning[],
): Promise<Result> {
  const append = (result: Result, truncated: boolean): Result => ({ ...result,
    warnings: [...baseWarnings, ...result.warnings, ...(truncated ? [OUTPUT] : [])] })
  const complete = append(initial, false)
  if (JSON.stringify(complete).length <= AGENT_HISTORY_PAGE_MAX_CHARS) return complete
  for (let limit = valueCount(initial) - 1; limit >= 1; limit -= 1) {
    const candidate = append(await query(limit), true)
    if (JSON.stringify(candidate).length <= AGENT_HISTORY_PAGE_MAX_CHARS) return candidate
  }
  throw new RangeError(`History result cannot fit within ${AGENT_HISTORY_PAGE_MAX_CHARS} serialized characters`)
}
