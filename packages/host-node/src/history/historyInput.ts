import {
  AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT,
  AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS,
  type AgentHistoryItemRole, type AgentHistoryStatus, type AgentHistoryTarget,
  type ListAgentHistoriesInput, type ListAgentHistoryItemsInput,
  type ReadAgentHistoryItemInput, type SearchAgentHistoriesInput,
} from '@einfach-agent/core/history'

const STATUS = new Set<AgentHistoryStatus>(['idle', 'running', 'awaiting_tool', 'waiting_user',
  'waiting_confirmation', 'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error', 'legacy'])
const ROLE = new Set<AgentHistoryItemRole>(['system', 'user', 'assistant', 'tool'])
function limit(value: unknown, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > maximum) {
    throw new RangeError(`limit must be between 1 and ${maximum}`)
  }
  return result as number
}
function values<T extends string>(input: unknown, allowed: ReadonlySet<T>, label: string): readonly T[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string' || !allowed.has(value as T))) {
    throw new TypeError(`${label} contains an invalid value`)
  }
  return input as T[]
}
function target(input: unknown): AgentHistoryTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('target must be an object')
  const value = input as Record<string, unknown>; const keys = Object.keys(value).sort().join(',')
  if (keys === 'conversationId,kind' && value.kind === 'root' && typeof value.conversationId === 'string' && value.conversationId) {
    return value as unknown as AgentHistoryTarget
  }
  if (keys === 'agentPath,conversationId,kind,runId' && value.kind === 'child'
    && [value.conversationId, value.runId, value.agentPath].every(part => typeof part === 'string' && part.length > 0)) {
    return value as unknown as AgentHistoryTarget
  }
  throw new TypeError('target is invalid')
}
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.length > 100_000) throw new TypeError('cursor is invalid')
  return value
}

export function normalizeHistoryListInput(input: ListAgentHistoriesInput): ListAgentHistoriesInput & { limit: number } {
  const statuses = values(input.statuses, STATUS, 'statuses'); const nextCursor = cursor(input.cursor)
  return { ...(input.target === undefined ? {} : { target: target(input.target) }),
    ...(statuses === undefined ? {} : { statuses }), ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT) }
}
export function normalizeHistoryItemsInput(input: ListAgentHistoryItemsInput): ListAgentHistoryItemsInput & { limit: number } {
  if (input.includeDeleted !== undefined && typeof input.includeDeleted !== 'boolean') throw new TypeError('includeDeleted is invalid')
  const roles = values(input.roles, ROLE, 'roles'); const nextCursor = cursor(input.cursor)
  return { target: target(input.target), ...(roles === undefined ? {} : { roles }),
    ...(input.includeDeleted === undefined ? {} : { includeDeleted: input.includeDeleted }),
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT) }
}
export function normalizeHistoryReadInput(input: ReadAgentHistoryItemInput): ReadAgentHistoryItemInput & { offset: number; limit: number } {
  if (typeof input.itemId !== 'string' || !input.itemId) throw new TypeError('itemId is invalid')
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative safe integer')
  return { target: target(input.target), itemId: input.itemId, offset,
    limit: limit(input.limit, AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT) }
}
export function normalizeHistorySearchInput(input: SearchAgentHistoriesInput): SearchAgentHistoriesInput & { limit: number } {
  if (typeof input.query !== 'string') throw new TypeError('query is invalid')
  const query = input.query.trim(); const count = [...query].length
  if (count < 1 || count > AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS) throw new RangeError('query is invalid')
  const roles = values(input.roles, ROLE, 'roles'); const nextCursor = cursor(input.cursor)
  return { query, ...(input.target === undefined ? {} : { target: target(input.target) }),
    ...(roles === undefined ? {} : { roles }), ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT) }
}
