import { AGENT_HISTORY_ITEM_ROLES, AgentHistoryError, decodeAgentHistoryTarget,
  type AgentHistoryItemRole, type AgentHistoryTarget } from '@einfach-agent/core/history'

export interface SearchCursorFilters {
  readonly query: string
  readonly target?: AgentHistoryTarget
  readonly roles: readonly AgentHistoryItemRole[]
}
export interface SearchCursorKey {
  readonly rank: number; readonly updatedAt: number; readonly historyId: string
  readonly itemOrdinal: number; readonly itemId: string
}
export interface SearchSnapshot { readonly eventCount: number; readonly watermark: number }
interface SearchCursor { readonly v: 1; readonly kind: 'search'; readonly filters: SearchCursorFilters
  readonly snapshot: SearchSnapshot; readonly key: SearchCursorKey }

const ROLES = new Set<AgentHistoryItemRole>(AGENT_HISTORY_ITEM_ROLES)
function invalid(message: string): never {
  throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', message)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) invalid('Search cursor has invalid fields')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Search cursor must be an object')
  return value as Record<string, unknown>
}
function nonempty(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) invalid(message)
  return value
}
function target(value: unknown): AgentHistoryTarget {
  try { return decodeAgentHistoryTarget(value) } catch { return invalid('Search cursor target is invalid') }
}
function safeNonnegative(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(message)
  return value as number
}
export function normalizeSearchFilters(input: {
  readonly query: string; readonly target?: AgentHistoryTarget; readonly roles?: readonly AgentHistoryItemRole[]
}): SearchCursorFilters {
  const roles = [...new Set(input.roles ?? [])].sort()
  if (roles.some(role => !ROLES.has(role))) throw new RangeError('roles contains an invalid role')
  return { query: input.query.trim(), ...(input.target ? { target: target(input.target) } : {}), roles }
}
export function encodeSearchCursor(cursor: Omit<SearchCursor, 'v' | 'kind'>): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: 'search', ...cursor })).toString('base64url')
}
export function assertSearchCursor(value: string | undefined, filters: SearchCursorFilters,
  snapshot: SearchSnapshot): SearchCursor | undefined {
  if (!value) return undefined
  let parsed: unknown
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid('Search cursor is not canonical base64url')
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    if (Buffer.from(decoded).toString('base64url') !== value) invalid('Search cursor is not canonical base64url')
    parsed = JSON.parse(decoded)
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error
    return invalid('Search cursor is malformed')
  }
  const cursor = object(parsed); exact(cursor, ['v', 'kind', 'filters', 'snapshot', 'key'])
  if (cursor.v !== 1 || cursor.kind !== 'search') invalid('Search cursor version or kind is invalid')
  const decodedFilters = object(cursor.filters)
  exact(decodedFilters, filters.target ? ['query', 'target', 'roles'] : ['query', 'roles'])
  if (filters.target) target(decodedFilters.target)
  if (JSON.stringify(decodedFilters) !== JSON.stringify(filters)) invalid('Search cursor filters changed')
  const decodedSnapshot = object(cursor.snapshot); exact(decodedSnapshot, ['eventCount', 'watermark'])
  safeNonnegative(decodedSnapshot.eventCount, 'Search cursor event snapshot is invalid')
  safeNonnegative(decodedSnapshot.watermark, 'Search cursor watermark is invalid')
  if (decodedSnapshot.eventCount !== snapshot.eventCount || decodedSnapshot.watermark !== snapshot.watermark) {
    throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'Search cursor snapshot is stale')
  }
  const key = object(cursor.key); exact(key, ['rank', 'updatedAt', 'historyId', 'itemOrdinal', 'itemId'])
  if (typeof key.rank !== 'number' || !Number.isFinite(key.rank)) invalid('Search cursor rank is invalid')
  safeNonnegative(key.updatedAt, 'Search cursor updatedAt is invalid')
  safeNonnegative(key.itemOrdinal, 'Search cursor itemOrdinal is invalid')
  nonempty(key.historyId, 'Search cursor historyId is invalid')
  nonempty(key.itemId, 'Search cursor itemId is invalid')
  return cursor as unknown as SearchCursor
}
