import {
  AGENT_HISTORY_CURSOR_MAX_CHARS, AGENT_HISTORY_ITEM_ROLES,
  AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT,
  AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS, AGENT_HISTORY_STATUSES,
  decodeAgentHistoryTarget,
  type AgentHistoryItemRole, type AgentHistoryStatus,
  type ListAgentHistoriesInput, type ListAgentHistoryItemsInput,
  type ReadAgentHistoryItemInput, type SearchAgentHistoriesInput,
} from '@einfach-agent/core/history'

const STATUS = new Set<AgentHistoryStatus>(AGENT_HISTORY_STATUSES)
const ROLE = new Set<AgentHistoryItemRole>(AGENT_HISTORY_ITEM_ROLES)
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
function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.length > AGENT_HISTORY_CURSOR_MAX_CHARS) {
    throw new TypeError('cursor is invalid')
  }
  return value
}

export function normalizeHistoryListInput(input: ListAgentHistoriesInput): ListAgentHistoriesInput & { limit: number } {
  const statuses = values(input.statuses, STATUS, 'statuses'); const nextCursor = cursor(input.cursor)
  return { ...(input.target === undefined ? {} : { target: decodeAgentHistoryTarget(input.target) }),
    ...(statuses === undefined ? {} : { statuses }), ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT) }
}
export function normalizeHistoryItemsInput(input: ListAgentHistoryItemsInput): ListAgentHistoryItemsInput & { limit: number } {
  if (input.includeDeleted !== undefined && typeof input.includeDeleted !== 'boolean') throw new TypeError('includeDeleted is invalid')
  const roles = values(input.roles, ROLE, 'roles'); const nextCursor = cursor(input.cursor)
  return { target: decodeAgentHistoryTarget(input.target), ...(roles === undefined ? {} : { roles }),
    ...(input.includeDeleted === undefined ? {} : { includeDeleted: input.includeDeleted }),
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT) }
}
export function normalizeHistoryReadInput(input: ReadAgentHistoryItemInput): ReadAgentHistoryItemInput & { offset: number; limit: number } {
  if (typeof input.itemId !== 'string' || !input.itemId) throw new TypeError('itemId is invalid')
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative safe integer')
  return { target: decodeAgentHistoryTarget(input.target), itemId: input.itemId, offset,
    limit: limit(input.limit, AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT) }
}
export function normalizeHistorySearchInput(input: SearchAgentHistoriesInput): SearchAgentHistoriesInput & { limit: number } {
  if (typeof input.query !== 'string') throw new TypeError('query is invalid')
  const query = input.query.trim(); const count = [...query].length
  if (count < 1 || count > AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS) throw new RangeError('query is invalid')
  const roles = values(input.roles, ROLE, 'roles'); const nextCursor = cursor(input.cursor)
  return { query, ...(input.target === undefined ? {} : { target: decodeAgentHistoryTarget(input.target) }),
    ...(roles === undefined ? {} : { roles }), ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    limit: limit(input.limit, AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT) }
}
