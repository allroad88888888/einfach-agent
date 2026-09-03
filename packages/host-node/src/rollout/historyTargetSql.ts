import {
  agentHistoryTargetIdentity,
  decodeAgentHistoryTargetIdentity,
  type AgentHistoryTarget,
} from '@einfach-agent/core/history'

export interface AgentHistoryTargetSqlRow {
  readonly target_kind: unknown
  readonly conversation_id: unknown
  readonly run_id: unknown
  readonly agent_path: unknown
}

const TARGET_COLUMNS = [
  ['target_kind', 'kind'],
  ['conversation_id', 'conversationId'],
  ['run_id', 'runId'],
  ['agent_path', 'agentPath'],
] as const

export function decodeAgentHistoryTargetSqlRow(row: AgentHistoryTargetSqlRow): AgentHistoryTarget {
  return decodeAgentHistoryTargetIdentity({
    kind: row.target_kind,
    conversationId: row.conversation_id,
    runId: row.run_id,
    agentPath: row.agent_path,
  })
}

export function agentHistoryTargetSqlPredicate(
  target: AgentHistoryTarget,
  start: number,
  qualifier = '',
): { readonly sql: string; readonly params: unknown[] } {
  const identity = agentHistoryTargetIdentity(target)
  const clauses: string[] = []
  const params: unknown[] = []
  for (const [column, field] of TARGET_COLUMNS) {
    const value = identity[field]
    if (value === null) clauses.push(`${qualifier}${column} IS NULL`)
    else {
      clauses.push(`${qualifier}${column}=$${start + params.length}`)
      params.push(value)
    }
  }
  return { sql: clauses.join(' AND '), params }
}
