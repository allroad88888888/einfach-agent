import { AGENT_HISTORY_CURSOR_MAX_CHARS, AgentHistoryError, decodeAgentHistoryTarget,
  type AgentHistoryTarget } from '@einfach-agent/core/history'

export type LegacyCursorKind = 'list' | 'items' | 'search'
export interface LegacyCursorFilters {
  readonly target: AgentHistoryTarget
  readonly query?: string
  readonly roles?: readonly string[]
  readonly includeDeleted?: boolean
}
interface LegacyCursor { readonly v: 1; readonly kind: LegacyCursorKind; readonly filters: LegacyCursorFilters; readonly offset: number }

function stable(value: LegacyCursorFilters): string {
  return JSON.stringify({
    ...value,
    target: decodeAgentHistoryTarget(value.target),
    ...(value.roles ? { roles: [...new Set(value.roles)].sort() } : {}),
  })
}
export function encodeHistoryServiceCursor(kind: LegacyCursorKind, filters: LegacyCursorFilters, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, filters: JSON.parse(stable(filters)), offset } satisfies LegacyCursor))
    .toString('base64url')
}
export function decodeHistoryServiceCursor(cursor: string | undefined, kind: LegacyCursorKind,
  filters: LegacyCursorFilters): number {
  if (!cursor) return 0
  if (cursor.length > AGENT_HISTORY_CURSOR_MAX_CHARS) {
    throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', 'Legacy history cursor is too large')
  }
  try {
    if (Buffer.from(cursor, 'base64url').toString('base64url') !== cursor) throw new Error('non-canonical base64url')
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'filters,kind,offset,v' || value.v !== 1 || value.kind !== kind
      || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0
      || stable(value.filters as LegacyCursorFilters) !== stable(filters)) throw new Error('shape')
    return value.offset as number
  } catch (cause) {
    throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', 'Invalid legacy history cursor', { cause })
  }
}
