import type { AgentHistoryCapabilityProvider, AgentHistoryItemRole, AgentHistoryStatus,
  AgentHistoryTarget } from '@einfach-agent/core/history'
import type { NodeHostRouteTable } from '../routeTable'

const ROLES = new Set<AgentHistoryItemRole>(['system', 'user', 'assistant', 'tool'])
const STATUSES = new Set<AgentHistoryStatus>(['idle', 'running', 'awaiting_tool', 'waiting_user',
  'waiting_confirmation', 'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error', 'legacy'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new TypeError(`${label} contains unknown key ${unknown}`)
}
function string(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || value.length < 1 || [...value].length > max) throw new RangeError(`${label} is invalid`)
  return value
}
function integer(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${label} is invalid`)
  return value as number
}
function target(value: unknown): AgentHistoryTarget {
  const input = object(value, 'target')
  if (input.kind === 'root') {
    exact(input, ['kind', 'conversationId'], 'target')
    return { kind: 'root', conversationId: string(input.conversationId, 'conversationId', 1_000) }
  }
  if (input.kind === 'child') {
    exact(input, ['kind', 'conversationId', 'runId', 'agentPath'], 'target')
    return { kind: 'child', conversationId: string(input.conversationId, 'conversationId', 1_000),
      runId: string(input.runId, 'runId', 1_000), agentPath: string(input.agentPath, 'agentPath', 1_000) }
  }
  throw new TypeError('target kind is invalid')
}
function listOf<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > allowed.size
    || value.some((item) => typeof item !== 'string' || !allowed.has(item as T))) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as T[]
}
function envelope(args: Record<string, unknown>): { input: Record<string, unknown>; legacyWorkspaceRoot?: string } {
  exact(args, ['input', 'legacyWorkspaceRoot'], 'history command envelope')
  const locator = args.legacyWorkspaceRoot === undefined ? undefined
    : string(args.legacyWorkspaceRoot, 'legacyWorkspaceRoot', 10_000)
  return { input: object(args.input, 'input'), ...(locator ? { legacyWorkspaceRoot: locator } : {}) }
}
function common(input: Record<string, unknown>, maximum = 100) {
  const limit = integer(input.limit, 'limit')
  if (limit !== undefined && (limit < 1 || limit > maximum)) throw new RangeError('limit is outside the command range')
  return { ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, 'cursor', 100_000) }),
    ...(limit === undefined ? {} : { limit }) }
}

export function createHistoryRoutes(provider: AgentHistoryCapabilityProvider): NodeHostRouteTable {
  const capability = (value: ReturnType<typeof envelope>) => provider.forContext({
    ...(value.legacyWorkspaceRoot ? { legacyWorkspaceRoot: value.legacyWorkspaceRoot } : {}),
  })
  return {
    async agent_history_list(args) {
      const value = envelope(args); exact(value.input, ['target', 'statuses', 'cursor', 'limit'], 'list input')
      const input = { ...common(value.input),
        ...(value.input.target === undefined ? {} : { target: target(value.input.target) }),
        ...(value.input.statuses === undefined ? {} : { statuses: listOf(value.input.statuses, STATUSES, 'statuses') }) }
      return capability(value).listHistories(input)
    },
    async agent_history_list_items(args) {
      const value = envelope(args); exact(value.input, ['target', 'roles', 'includeDeleted', 'cursor', 'limit'], 'items input')
      if (value.input.includeDeleted !== undefined && typeof value.input.includeDeleted !== 'boolean') throw new TypeError('includeDeleted is invalid')
      const input = { ...common(value.input), target: target(value.input.target),
        ...(value.input.includeDeleted === undefined ? {} : { includeDeleted: value.input.includeDeleted as boolean }),
        ...(value.input.roles === undefined ? {} : { roles: listOf(value.input.roles, ROLES, 'roles') }) }
      return capability(value).listItems(input)
    },
    async agent_history_read_item(args) {
      const value = envelope(args); exact(value.input, ['target', 'itemId', 'offset', 'limit'], 'read input')
      const readLimit = integer(value.input.limit, 'limit')
      const offset = integer(value.input.offset, 'offset')
      if (readLimit !== undefined && (readLimit < 1 || readLimit > 20_000)) throw new RangeError('limit is outside the command range')
      const input = { target: target(value.input.target),
        itemId: string(value.input.itemId, 'itemId', 10_000),
        ...(offset === undefined ? {} : { offset }),
        ...(readLimit === undefined ? {} : { limit: readLimit }) }
      return capability(value).readItem(input)
    },
    async agent_history_search(args) {
      const value = envelope(args); exact(value.input, ['query', 'target', 'roles', 'cursor', 'limit'], 'search input')
      const rawQuery = value.input.query
      if (typeof rawQuery !== 'string') throw new RangeError('query is invalid')
      const query = rawQuery.trim()
      if ([...query].length < 1 || [...query].length > 1_000) throw new RangeError('query is invalid')
      const input = { ...common(value.input, 50), query,
        ...(value.input.target === undefined ? {} : { target: target(value.input.target) }),
        ...(value.input.roles === undefined ? {} : { roles: listOf(value.input.roles, ROLES, 'roles') }) }
      return capability(value).search(input)
    },
  }
}
