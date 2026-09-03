import {
  AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT,
  AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT,
  AGENT_RUN_STATUSES, AgentHistoryError, agentHistoryItemJson, agentHistoryItemPreview, agentHistoryItemRole,
  decodeAgentHistoryModelItem, readAgentHistoryText,
  type AgentHistoryItemSummary, type AgentHistoryStatus, type AgentHistorySummary,
  type AgentHistoryTarget, type ListAgentHistoriesInput, type ListAgentHistoriesResult,
  type ListAgentHistoryItemsInput, type ListAgentHistoryItemsResult,
  type MaterializedAgentHistoryItemSummary, type ReadAgentHistoryItemInput,
  type ReadAgentHistoryItemResult,
} from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import {
  assertRolloutCursor, encodeRolloutQueryCursor, normalizeHistoryCursorFilters,
  normalizeItemCursorFilters, type ItemCursorFilters,
} from './queryCursor'
import { agentHistoryTargetSqlPredicate, decodeAgentHistoryTargetSqlRow } from './historyTargetSql'
import { assertEmptyQueryPageFits, fitQueryPage } from './queryPageBudget'

interface CatalogRow {
  history_id: unknown; target_kind: unknown; conversation_id: unknown; run_id: unknown; agent_path: unknown
  title: unknown; created_at: unknown; updated_at: unknown; complete: unknown; last_rollout_ordinal: unknown
  status: unknown; item_count: unknown
}
interface ItemRow {
  history_id: unknown; item_id: unknown; item_ordinal: unknown; created_at: unknown; item_json: unknown
  pending: unknown; plan_stage_id: unknown; deleted: unknown
}
interface ParsedItem { readonly summary: AgentHistoryItemSummary; readonly decoded?: ReturnType<typeof decodeAgentHistoryModelItem> }
interface ItemKey { readonly itemOrdinal: number | null; readonly itemId: string }

export interface RolloutQueryRepository {
  listHistories(input: ListAgentHistoriesInput): Promise<ListAgentHistoriesResult>
  listItems(input: ListAgentHistoryItemsInput): Promise<ListAgentHistoryItemsResult>
  readItem(input: ReadAgentHistoryItemInput): Promise<ReadAgentHistoryItemResult>
}

const OUTPUT_WARNING = { code: 'OUTPUT_TRUNCATED' as const,
  message: 'History page was truncated to the maximum serialized output size' }
const SCAN_WARNING = { code: 'OUTPUT_TRUNCATED' as const,
  message: 'History item scan reached its bounded per-request row limit; continue with nextCursor' }
const ITEM_SCAN_BATCH = 100
const ITEM_SCAN_MAX_ROWS = 200

function corrupt(message: string, options?: ErrorOptions): never {
  throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', message, options)
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt(`Invalid canonical ${label}`)
  return value as number
}
function flag(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) corrupt(`Invalid canonical ${label}`)
  return value === 1
}
function targetFrom(row: CatalogRow): AgentHistoryTarget {
  try { return decodeAgentHistoryTargetSqlRow(row) } catch (cause) {
    return corrupt('Invalid catalog target identity', { cause })
  }
}
function summary(row: CatalogRow): AgentHistorySummary {
  if (typeof row.history_id !== 'string' || row.history_id.length === 0 || typeof row.title !== 'string') corrupt('Invalid catalog summary')
  const status = row.status === null ? 'idle' : row.status
  if (typeof status !== 'string' || !AGENT_RUN_STATUSES.some(allowed => allowed === status)) {
    corrupt('Invalid canonical run status')
  }
  integer(row.last_rollout_ordinal, 'last rollout ordinal')
  return { historyId: row.history_id, target: targetFrom(row), title: row.title,
    createdAt: integer(row.created_at, 'created at'), updatedAt: integer(row.updated_at, 'updated at'),
    status: status as AgentHistoryStatus, complete: flag(row.complete, 'complete flag'),
    itemCount: integer(row.item_count, 'item count') }
}
function parsedItem(row: ItemRow): ParsedItem {
  if (typeof row.history_id !== 'string' || row.history_id.length === 0
    || typeof row.item_id !== 'string' || row.item_id.length === 0) corrupt('Invalid canonical item identity')
  const deleted = flag(row.deleted, 'deleted flag'); const pending = flag(row.pending, 'pending flag')
  const planStageId = row.plan_stage_id === null || typeof row.plan_stage_id === 'string'
    ? row.plan_stage_id : corrupt('Invalid plan stage')
  if (row.item_json === null && row.item_ordinal === null && row.created_at === null) {
    if (!deleted || pending || planStageId !== null) corrupt('Invalid unknown-item tombstone')
    return { summary: { historyId: row.history_id, itemId: row.item_id, materialized: false,
      itemOrdinal: null, createdAt: null, role: null, preview: '', pending: false,
      planStageId: null, deleted: true } }
  }
  if (typeof row.item_json !== 'string') corrupt('Incomplete materialized canonical item')
  let decoded
  try { decoded = decodeAgentHistoryModelItem(row.item_json) } catch (cause) {
    corrupt(`Invalid canonical item ${row.item_id}`, { cause })
  }
  return { decoded, summary: { historyId: row.history_id, itemId: row.item_id, materialized: true,
    itemOrdinal: integer(row.item_ordinal, 'item ordinal'), createdAt: integer(row.created_at, 'item created at'),
    role: agentHistoryItemRole(decoded), preview: agentHistoryItemPreview(decoded), pending,
    planStageId, deleted } }
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new RangeError(`limit must be between 1 and ${maximum}`)
  return result
}
const CATALOG_SELECT = `SELECT c.*,
 (SELECT status FROM agent_rollout_turns t WHERE t.history_id=c.history_id ORDER BY last_change_ordinal DESC,turn_key DESC LIMIT 1) status,
 (SELECT COUNT(*) FROM agent_rollout_items i WHERE i.history_id=c.history_id AND deleted=0) item_count
 FROM agent_rollout_catalog c`

function itemAfter(key: ItemKey | undefined, parameter: number): { sql?: string; params: unknown[] } {
  if (!key) return { params: [] }
  return key.itemOrdinal === null
    ? { sql: `((item_ordinal IS NULL AND item_id>$${parameter}) OR item_ordinal IS NOT NULL)`, params: [key.itemId] }
    : { sql: `(item_ordinal>$${parameter} OR (item_ordinal=$${parameter} AND item_id>$${parameter + 1}))`,
      params: [key.itemOrdinal, key.itemId] }
}

export function createRolloutQueryRepository(executor: SqlExecutor): RolloutQueryRepository {
  async function eventSnapshot(): Promise<number> {
    const rows = await executor.select<Array<{ count: unknown }>>('SELECT COUNT(*) count FROM agent_rollout_events')
    return integer(rows[0]?.count, 'event snapshot')
  }
  async function catalogFor(target: AgentHistoryTarget): Promise<CatalogRow> {
    const match = agentHistoryTargetSqlPredicate(target, 1)
    const rows = await executor.select<CatalogRow[]>(`${CATALOG_SELECT} WHERE ${match.sql}`, match.params)
    if (rows.length === 0) throw new AgentHistoryError('AGENT_HISTORY_NOT_FOUND', 'History not found')
    if (rows.length !== 1) corrupt('Target resolves to multiple canonical histories')
    summary(rows[0]!); return rows[0]!
  }
  async function scanItems(historyId: string, filters: ItemCursorFilters, start: ItemKey | undefined, wanted: number) {
    const matches: ParsedItem[] = []; let scannedKey = start; let exhausted = false; let scanned = 0
    while (matches.length < wanted && !exhausted && scanned < ITEM_SCAN_MAX_ROWS) {
      const params: unknown[] = [historyId]; const where = ['history_id=$1']
      if (!filters.includeDeleted) where.push('deleted=0')
      const after = itemAfter(scannedKey, params.length + 1); if (after.sql) where.push(after.sql); params.push(...after.params)
      const batchLimit = Math.min(ITEM_SCAN_BATCH, ITEM_SCAN_MAX_ROWS - scanned); params.push(batchLimit)
      const rows = await executor.select<ItemRow[]>(`SELECT * FROM agent_rollout_items WHERE ${where.join(' AND ')}
       ORDER BY item_ordinal ASC,item_id ASC LIMIT $${params.length}`, params)
      exhausted = rows.length < batchLimit
      for (const row of rows) {
        const parsed = parsedItem(row)
        scanned += 1
        scannedKey = { itemOrdinal: parsed.summary.itemOrdinal, itemId: parsed.summary.itemId }
        if (!filters.roles.length || (parsed.summary.role !== null && filters.roles.includes(parsed.summary.role))) {
          matches.push(parsed)
          if (matches.length === wanted) break
        }
      }
    }
    return { matches, scannedKey, exhausted, capReached: scanned >= ITEM_SCAN_MAX_ROWS && !exhausted }
  }
  return {
    async listHistories(input) {
      const pageLimit = limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT)
      const filters = normalizeHistoryCursorFilters(input); const snapshot = await eventSnapshot()
      const cursor = assertRolloutCursor(input.cursor, 'histories', filters, snapshot)
      const where: string[] = []; const params: unknown[] = []
      if (filters.target) {
        const match = agentHistoryTargetSqlPredicate(filters.target, 1)
        where.push(match.sql); params.push(...match.params)
      }
      if (filters.statuses.length) {
        const slots = filters.statuses.map((_, index) => `$${params.length + index + 1}`)
        where.push(`COALESCE((SELECT status FROM agent_rollout_turns t WHERE t.history_id=c.history_id ORDER BY last_change_ordinal DESC,turn_key DESC LIMIT 1),'idle') IN (${slots})`)
        params.push(...filters.statuses)
      }
      if (cursor) { where.push(`(updated_at<$${params.length + 1} OR (updated_at=$${params.length + 1} AND history_id>$${params.length + 2}))`); params.push(cursor.key.updatedAt, cursor.key.historyId) }
      params.push(pageLimit + 1)
      const rows = await executor.select<CatalogRow[]>(`${CATALOG_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC,history_id ASC LIMIT $${params.length}`, params)
      const candidates = rows.slice(0, pageLimit).map(summary); const hasMore = rows.length > pageLimit
      if (!candidates.length) return assertEmptyQueryPageFits({ histories: [], warnings: [] })
      return fitQueryPage(candidates.length, (count, truncated): ListAgentHistoriesResult => {
        const histories = candidates.slice(0, count); const more = hasMore || truncated; const last = histories.at(-1)!
        return { histories, warnings: truncated ? [OUTPUT_WARNING] : [], ...(more ? { nextCursor:
          encodeRolloutQueryCursor({ kind: 'histories', filters, snapshot,
            key: { updatedAt: last.updatedAt, historyId: last.historyId } }) } : {}) }
      }).result
    },
    async listItems(input) {
      const pageLimit = limit(input.limit, AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT)
      const filters = normalizeItemCursorFilters(input); const catalog = await catalogFor(filters.target)
      const history = summary(catalog); const snapshot = integer(catalog.last_rollout_ordinal, 'last rollout ordinal')
      const cursor = assertRolloutCursor(input.cursor, 'items', filters, snapshot)
      const scan = await scanItems(catalog.history_id as string, filters, cursor?.key, pageLimit + 1)
      const candidates = scan.matches.slice(0, pageLimit).map(item => item.summary)
      const unreturnedMatch = scan.matches.length > pageLimit
      const scanContinuation = scan.capReached && !unreturnedMatch
      if (!candidates.length) {
        if (scanContinuation && scan.scannedKey) return assertEmptyQueryPageFits({ history, items: [],
          nextCursor: encodeRolloutQueryCursor({ kind: 'items', filters, snapshot, key: scan.scannedKey }),
          warnings: [SCAN_WARNING] })
        return assertEmptyQueryPageFits({ history, items: [], warnings: [] })
      }
      return fitQueryPage(candidates.length, (count, truncated): ListAgentHistoryItemsResult => {
        const items = candidates.slice(0, count); const last = items.at(-1)!
        const more = unreturnedMatch || scanContinuation || truncated
        const key = scanContinuation && !truncated ? scan.scannedKey! : {
          itemOrdinal: last.itemOrdinal, itemId: last.itemId,
        }
        const warnings = truncated ? [OUTPUT_WARNING] : scanContinuation ? [SCAN_WARNING] : []
        return { history, items, warnings, ...(more ? { nextCursor:
          encodeRolloutQueryCursor({ kind: 'items', filters, snapshot, key }) } : {}) }
      }).result
    },
    async readItem(input) {
      if (typeof input.itemId !== 'string' || input.itemId.length === 0) throw new RangeError('itemId must not be empty')
      const catalog = await catalogFor(input.target)
      const rows = await executor.select<ItemRow[]>('SELECT * FROM agent_rollout_items WHERE history_id=$1 AND item_id=$2',
        [catalog.history_id, input.itemId])
      if (!rows.length) throw new AgentHistoryError('AGENT_HISTORY_ITEM_NOT_FOUND', 'History item not found')
      const parsed = parsedItem(rows[0]!)
      if (parsed.summary.deleted) throw new AgentHistoryError('AGENT_HISTORY_ITEM_DELETED', 'History item was deleted')
      if (!parsed.decoded || !parsed.summary.materialized) corrupt('Unreadable canonical item')
      const chunk = readAgentHistoryText(agentHistoryItemJson(parsed.decoded), input.offset ?? 0,
        limit(input.limit, AGENT_HISTORY_READ_DEFAULT_LIMIT, AGENT_HISTORY_READ_MAX_LIMIT))
      return { item: parsed.summary as MaterializedAgentHistoryItemSummary, ...chunk, warnings: [] }
    },
  }
}
