import {
  AgentHistoryError, type AgentHistoryItemRole, type AgentHistoryStatus, type AgentHistoryTarget,
} from '@einfach-agent/core/history'

export type RolloutQueryCursor =
  | { readonly kind: 'histories'; readonly filters: HistoryCursorFilters; readonly snapshot: number;
      readonly key: { readonly updatedAt: number; readonly historyId: string } }
  | { readonly kind: 'items'; readonly filters: ItemCursorFilters; readonly snapshot: number;
      readonly key: { readonly itemOrdinal: number | null; readonly itemId: string } }

export interface HistoryCursorFilters {
  readonly target?: AgentHistoryTarget
  readonly statuses: readonly AgentHistoryStatus[]
}

export interface ItemCursorFilters {
  readonly target: AgentHistoryTarget
  readonly includeDeleted: boolean
  readonly roles: readonly AgentHistoryItemRole[]
}

const STATUSES: readonly AgentHistoryStatus[] = [
  'idle', 'running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation',
  'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error', 'legacy',
]
const ROLES: readonly AgentHistoryItemRole[] = ['system', 'user', 'assistant', 'tool']

function invalid(message: string): never {
  throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', message)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function target(value: unknown): AgentHistoryTarget {
  const row = record(value)
  if (!row || typeof row.conversationId !== 'string' || row.conversationId.length === 0) invalid('Invalid cursor target')
  if (row.kind === 'root' && exactKeys(row, ['kind', 'conversationId'])) {
    return { kind: 'root', conversationId: row.conversationId as string }
  }
  if (row.kind === 'child' && exactKeys(row, ['kind', 'conversationId', 'runId', 'agentPath'])
    && typeof row.runId === 'string' && row.runId.length > 0
    && typeof row.agentPath === 'string' && row.agentPath.length > 0) {
    return { kind: 'child', conversationId: row.conversationId as string,
      runId: row.runId, agentPath: row.agentPath }
  }
  return invalid('Invalid cursor target')
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`Invalid cursor ${label}`)
  return value as number
}

export function normalizeHistoryCursorFilters(input: {
  readonly target?: AgentHistoryTarget; readonly statuses?: readonly AgentHistoryStatus[]
}): HistoryCursorFilters {
  const statuses = [...new Set(input.statuses ?? [])].sort()
  if (!statuses.every(status => STATUSES.includes(status))) invalid('Invalid history status filter')
  return { ...(input.target ? { target: target(input.target) } : {}), statuses }
}

export function normalizeItemCursorFilters(input: {
  readonly target: AgentHistoryTarget; readonly includeDeleted?: boolean; readonly roles?: readonly AgentHistoryItemRole[]
}): ItemCursorFilters {
  const roles = [...new Set(input.roles ?? [])].sort()
  if (!roles.every(role => ROLES.includes(role))) invalid('Invalid item role filter')
  return { target: target(input.target), includeDeleted: input.includeDeleted === true, roles }
}

export function encodeRolloutQueryCursor(cursor: RolloutQueryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url')
}

export function decodeRolloutQueryCursor(encoded: string): RolloutQueryCursor {
  let value: unknown
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid('Cursor is not base64url')
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) invalid('Cursor is not canonical base64url')
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error
    return invalid('Cursor is not valid JSON')
  }
  const row = record(value)
  if (!row || row.v !== 1 || !exactKeys(row, ['v', 'kind', 'filters', 'snapshot', 'key'])) invalid('Invalid cursor envelope')
  const snapshot = safeInteger(row.snapshot, 'snapshot')
  const filters = record(row.filters)
  const key = record(row.key)
  if (row.kind === 'histories' && filters && key && exactKeys(filters,
    Object.hasOwn(filters, 'target') ? ['target', 'statuses'] : ['statuses'])
    && Array.isArray(filters.statuses) && exactKeys(key, ['updatedAt', 'historyId'])
    && typeof key.historyId === 'string') {
    return { kind: 'histories', snapshot,
      filters: normalizeHistoryCursorFilters({
        ...(Object.hasOwn(filters, 'target') ? { target: target(filters.target) } : {}),
        statuses: filters.statuses as AgentHistoryStatus[],
      }), key: { updatedAt: safeInteger(key.updatedAt, 'updatedAt'), historyId: key.historyId } }
  }
  if (row.kind === 'items' && filters && key && exactKeys(filters, ['target', 'includeDeleted', 'roles'])
    && typeof filters.includeDeleted === 'boolean' && Array.isArray(filters.roles)
    && exactKeys(key, ['itemOrdinal', 'itemId']) && typeof key.itemId === 'string') {
    return { kind: 'items', snapshot,
      filters: normalizeItemCursorFilters({ target: target(filters.target), includeDeleted: filters.includeDeleted,
        roles: filters.roles as AgentHistoryItemRole[] }),
      key: { itemOrdinal: key.itemOrdinal === null ? null : safeInteger(key.itemOrdinal, 'itemOrdinal'), itemId: key.itemId } }
  }
  return invalid('Invalid cursor payload')
}

export function assertRolloutCursor<T extends RolloutQueryCursor['kind']>(
  encoded: string | undefined, kind: T, filters: Extract<RolloutQueryCursor, { kind: T }>['filters'], snapshot: number,
): Extract<RolloutQueryCursor, { kind: T }> | undefined {
  if (!encoded) return undefined
  const cursor = decodeRolloutQueryCursor(encoded)
  if (cursor.kind !== kind || JSON.stringify(cursor.filters) !== JSON.stringify(filters)) invalid('Cursor does not match query')
  if (cursor.snapshot !== snapshot) throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'History changed after cursor was issued')
  return cursor as Extract<RolloutQueryCursor, { kind: T }>
}
