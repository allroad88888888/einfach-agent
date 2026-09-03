import {
  AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_SNIPPET_MAX_CHARS, AGENT_HISTORY_PAGE_MAX_CHARS, AgentHistoryError,
  agentHistoryItemPreview, agentHistoryItemRole, agentHistoryItemSearchText, decodeAgentHistoryModelItem,
  type AgentHistorySearchHit,
  type SearchAgentHistoriesInput, type SearchAgentHistoriesResult,
} from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { agentHistoryTargetSqlPredicate, decodeAgentHistoryTargetSqlRow } from './historyTargetSql'
import { assertSearchCursor, encodeSearchCursor, normalizeSearchFilters,
  type SearchSnapshot } from './searchCursor'
import { derivedSearchFailure, isDerivedSearchFailure, MixedSearchIndexSqlError } from './searchIndexFailure'
import { agentHistoryMatchExpression } from './searchText'

interface SearchRow {
  rank: unknown; snippet: unknown; f_content: unknown; f_history_id: unknown; f_item_id: unknown; f_role: unknown
  f_item_ordinal: unknown; f_created_at: unknown; updated_at: unknown; item_json: unknown
  c_history_id: unknown; i_history_id: unknown; i_item_id: unknown; i_item_ordinal: unknown; i_created_at: unknown
  target_kind: unknown; conversation_id: unknown; run_id: unknown; agent_path: unknown
  pending: unknown; plan_stage_id: unknown; deleted: unknown
}
interface DecodedSearchRow { readonly hit: AgentHistorySearchHit
  readonly key: { readonly rank: number; readonly updatedAt: number; readonly historyId: string
    readonly itemOrdinal: number; readonly itemId: string } }
const OUTPUT_WARNING = { code: 'OUTPUT_TRUNCATED' as const,
  message: 'Search page was truncated to the maximum serialized output size' }
function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Corrupt search ${name}`)
  return value
}
function timestamp(value: unknown, name: string): number {
  const result = number(value, name)
  if (result < 0) throw new Error(`Corrupt search ${name}`)
  return result
}
function integer(value: unknown, name: string): number {
  const result = number(value, name)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Corrupt search ${name}`)
  return result
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Corrupt search ${name}`)
  return value
}
function prefix(text: string, maximum: number): string {
  let index = 0; let count = 0
  while (index < text.length && count < maximum) {
    const high = text.charCodeAt(index); const low = text.charCodeAt(index + 1)
    index += high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF ? 2 : 1
    count += 1
  }
  return text.slice(0, index)
}
function decodeRow(row: SearchRow): DecodedSearchRow {
  if (row.c_history_id === null || row.i_history_id === null) {
    throw derivedSearchFailure('Search hit has no canonical identity')
  }
  if (row.deleted !== 0) throw new Error('Corrupt deleted search hit')
  if (row.pending !== 0 && row.pending !== 1) throw new Error('Corrupt search pending flag')
  const item = decodeAgentHistoryModelItem(string(row.item_json, 'item JSON'))
  const role = agentHistoryItemRole(item)
  const historyId = string(row.c_history_id, 'catalog history id')
  const itemHistoryId = string(row.i_history_id, 'item history id')
  const itemId = string(row.i_item_id, 'item id')
  const itemOrdinal = integer(row.i_item_ordinal, 'item ordinal')
  const createdAt = timestamp(row.i_created_at, 'created at')
  if (itemHistoryId !== historyId) throw new Error('Corrupt canonical item identity')
  if (row.f_content !== agentHistoryItemSearchText(item) || row.f_history_id !== historyId
    || row.f_item_id !== itemId || row.f_role !== role || row.f_item_ordinal !== itemOrdinal
    || row.f_created_at !== createdAt) throw derivedSearchFailure('Search hit differs from canonical item')
  const rank = number(row.rank, 'rank'); const updatedAt = integer(row.updated_at, 'updated at')
  const hit: AgentHistorySearchHit = { materialized: true, historyId, itemId, itemOrdinal, createdAt, role,
    preview: agentHistoryItemPreview(item),
    pending: row.pending === 1, planStageId: row.plan_stage_id === null ? null : string(row.plan_stage_id, 'plan stage'),
    deleted: false, target: decodeAgentHistoryTargetSqlRow(row), snippet: prefix(string(row.snippet, 'snippet'),
      AGENT_HISTORY_SEARCH_SNIPPET_MAX_CHARS), rank }
  return { hit, key: { rank, updatedAt, historyId, itemOrdinal, itemId } }
}
export async function queryAgentHistorySearch(executor: SqlExecutor, input: SearchAgentHistoriesInput,
  snapshot: SearchSnapshot, baseWarnings: SearchAgentHistoriesResult['warnings'] = []): Promise<SearchAgentHistoriesResult> {
  const pageLimit = input.limit ?? AGENT_HISTORY_SEARCH_DEFAULT_LIMIT
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > AGENT_HISTORY_SEARCH_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${AGENT_HISTORY_SEARCH_MAX_LIMIT}`)
  }
  const filters = normalizeSearchFilters(input); const match = agentHistoryMatchExpression(filters.query)
  const cursor = assertSearchCursor(input.cursor, filters, snapshot)
  const params: unknown[] = [match]; const where = ['agent_history_search_fts MATCH $1', 'i.deleted=0']
  if (filters.target) {
    const clause = agentHistoryTargetSqlPredicate(filters.target, params.length + 1, 'c.')
    where.push(clause.sql); params.push(...clause.params)
  }
  if (filters.roles.length) {
    where.push(`f.role IN (${filters.roles.map((_, index) => `$${params.length + index + 1}`).join(',')})`)
    params.push(...filters.roles)
  }
  if (cursor) {
    const key = cursor.key; const start = params.length + 1
    where.push(`(bm25(agent_history_search_fts)>$${start} OR
      (bm25(agent_history_search_fts)=$${start} AND (c.updated_at<$${start + 1} OR
      (c.updated_at=$${start + 1} AND (f.history_id>$${start + 2} OR
      (f.history_id=$${start + 2} AND (CAST(f.item_ordinal AS INTEGER)>$${start + 3} OR
      (CAST(f.item_ordinal AS INTEGER)=$${start + 3} AND f.item_id>$${start + 4}))))))))`)
    params.push(key.rank, key.updatedAt, key.historyId, key.itemOrdinal, key.itemId)
  }
  params.push(pageLimit + 1)
  let rows: SearchRow[]
  try {
    rows = await executor.select<SearchRow[]>(`SELECT bm25(agent_history_search_fts) rank,
      snippet(agent_history_search_fts,0,'[',']','…',32) snippet,
      f.content f_content,f.history_id f_history_id,f.item_id f_item_id,f.role f_role,
      CAST(f.item_ordinal AS INTEGER) f_item_ordinal,CAST(f.created_at AS REAL) f_created_at,
      c.history_id c_history_id,c.updated_at,i.history_id i_history_id,i.item_id i_item_id,
      i.item_ordinal i_item_ordinal,i.created_at i_created_at,i.item_json,
      c.target_kind,c.conversation_id,c.run_id,c.agent_path,i.pending,i.plan_stage_id,i.deleted
      FROM agent_history_search_fts f LEFT JOIN agent_rollout_catalog c ON c.history_id=f.history_id
      LEFT JOIN agent_rollout_items i ON i.history_id=f.history_id AND i.item_id=f.item_id
      WHERE ${where.map(clause => clause === 'i.deleted=0' ? '(i.deleted=0 OR i.history_id IS NULL)' : clause).join(' AND ')}
      ORDER BY rank ASC,c.updated_at DESC,f.history_id ASC,
      i.item_ordinal ASC,f.item_id ASC LIMIT $${params.length}`, params)
  } catch (cause) {
    throw new MixedSearchIndexSqlError(cause)
  }
  let candidates: DecodedSearchRow[]
  try { candidates = rows.slice(0, pageLimit).map(decodeRow) } catch (cause) {
    if (cause instanceof AgentHistoryError || isDerivedSearchFailure(cause)) throw cause
    throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', 'Canonical history search row is corrupt', { cause })
  }
  let count = candidates.length
  const moreFromSql = rows.length > pageLimit
  const makeResult = (decoded: readonly DecodedSearchRow[], truncated: boolean): SearchAgentHistoriesResult => {
    const more = moreFromSql || truncated; const last = decoded.at(-1)
    return { hits: decoded.map(value => value.hit), warnings: truncated ? [...baseWarnings, OUTPUT_WARNING] : baseWarnings,
      ...(more && last ? { nextCursor: encodeSearchCursor({ filters, snapshot, key: last.key }) } : {}) }
  }
  while (count > 0 && JSON.stringify(makeResult(candidates.slice(0, count), count < candidates.length)).length
    > AGENT_HISTORY_PAGE_MAX_CHARS) count -= 1
  if (candidates.length && count === 0) throw new RangeError('Search result cannot fit output limit')
  return makeResult(candidates.slice(0, count), count < candidates.length)
}
