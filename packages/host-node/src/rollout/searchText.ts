import { AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS } from '@einfach-agent/core/history'

/** Turns user text into a literal-token FTS5 expression, never an operator expression. */
export function agentHistoryMatchExpression(query: string): string {
  const trimmed = query.trim()
  let count = 0
  for (const _character of trimmed) count += 1
  if (!trimmed || count > AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS) {
    throw new RangeError(`query must contain between 1 and ${AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS} characters`)
  }
  const tokens = trimmed.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (!tokens.length) return `"${trimmed.replaceAll('"', '""')}"`
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}
