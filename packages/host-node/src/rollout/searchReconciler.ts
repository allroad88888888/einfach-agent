import { agentHistoryItemRole, agentHistoryItemSearchText, decodeAgentRolloutRecord } from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { derivedSearchFailure, MixedSearchIndexSqlError } from './searchIndexFailure'
import { AGENT_HISTORY_SEARCH_SCHEMA_VERSION } from './searchSchema'

export interface SearchReconcileResult { readonly eventsApplied: number; readonly lagging: boolean; readonly watermark: number }
export interface SearchReconcilerOptions { readonly maxHistories?: number; readonly maxEvents?: number
  readonly afterMutation?: (historyId: string, ordinal: number) => void | Promise<void> }
interface HistoryRow { history_id: unknown; last_rollout_ordinal: unknown; indexed_ordinal: unknown }
interface EventRow { history_id: unknown; rollout_ordinal: unknown; event_json: unknown }
const integer = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < -1) throw new Error(`Corrupt search ${name}`)
  return value as number
}
const derivedInteger = (value: unknown, name: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw derivedSearchFailure(`Corrupt search ${name}`)
  return value as number
}
async function derived(operation: () => Promise<unknown>, message: string): Promise<void> {
  try { await operation() } catch (cause) { throw derivedSearchFailure(message, cause) }
}

/** Applies a bounded prefix of append-only rollout events to the FTS projection. */
export async function reconcileAgentHistorySearch(executor: SqlExecutor,
  options: SearchReconcilerOptions = {}): Promise<SearchReconcileResult> {
  const maxHistories = options.maxHistories ?? 20; const maxEvents = options.maxEvents ?? 200
  if (!Number.isSafeInteger(maxHistories) || maxHistories < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError('Search reconciliation bounds must be positive safe integers')
  }
  let mismatches: Array<{ count: unknown }>
  try { mismatches = await executor.select<Array<{ count: unknown }>>(
    'SELECT COUNT(*) count FROM agent_history_search_state WHERE schema_version<>$1',
    [AGENT_HISTORY_SEARCH_SCHEMA_VERSION]) } catch (cause) {
    throw derivedSearchFailure('Search state cannot be read', cause)
  }
  if (derivedInteger(mismatches[0]?.count, 'schema mismatch count') > 0) {
    throw derivedSearchFailure('Search schema version mismatch')
  }
  let histories: HistoryRow[]
  try { histories = await executor.select<HistoryRow[]>(`SELECT c.history_id,c.last_rollout_ordinal,
      COALESCE(s.indexed_rollout_ordinal,-1) indexed_ordinal FROM agent_rollout_catalog c
      LEFT JOIN agent_history_search_state s ON s.history_id=c.history_id
      WHERE typeof(c.last_rollout_ordinal)<>'integer' OR c.last_rollout_ordinal<0
      OR (s.history_id IS NOT NULL AND (typeof(s.indexed_rollout_ordinal)<>'integer' OR s.indexed_rollout_ordinal< -1))
      OR c.last_rollout_ordinal>COALESCE(s.indexed_rollout_ordinal,-1)
      ORDER BY c.history_id LIMIT $1`, [maxHistories]) } catch (cause) {
    throw new MixedSearchIndexSqlError(cause)
  }
  let applied = 0
  for (const history of histories) {
    const historyId = typeof history.history_id === 'string' ? history.history_id : (() => { throw new Error('Corrupt history id') })()
    integer(history.last_rollout_ordinal, 'catalog ordinal')
    let indexed = derivedInteger(history.indexed_ordinal, 'watermark', -1)
    const remaining = maxEvents - applied
    if (remaining <= 0) break
    const events = await executor.select<EventRow[]>(`SELECT history_id,rollout_ordinal,event_json
      FROM agent_rollout_events WHERE history_id=$1 AND rollout_ordinal>$2
      ORDER BY rollout_ordinal LIMIT $3`, [historyId, indexed, remaining])
    for (const row of events) {
      const ordinal = integer(row.rollout_ordinal, 'event ordinal')
      if (row.history_id !== historyId || ordinal !== indexed + 1 || typeof row.event_json !== 'string') {
        throw new Error('Corrupt search event sequence')
      }
      const event = decodeAgentRolloutRecord(row.event_json)
      if (event.historyId !== historyId || event.rolloutOrdinal !== ordinal) throw new Error('Corrupt search event identity')
      if (event.mutationType === 'item_upsert') {
        await derived(() => executor.execute('DELETE FROM agent_history_search_fts WHERE history_id=$1 AND item_id=$2',
          [historyId, event.itemId]), 'Search item delete failed')
        await derived(() => executor.execute(`INSERT INTO agent_history_search_fts
          (content,history_id,item_id,role,item_ordinal,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [agentHistoryItemSearchText(event.item), historyId, event.itemId, agentHistoryItemRole(event.item),
          event.itemOrdinal, event.createdAt, Date.parse(event.recordedAt)]), 'Search item insert failed')
      } else if (event.mutationType === 'item_deleted') {
        await derived(() => executor.execute('DELETE FROM agent_history_search_fts WHERE history_id=$1 AND item_id=$2',
          [historyId, event.itemId]), 'Search item delete failed')
      }
      await options.afterMutation?.(historyId, ordinal)
      await derived(() => executor.execute(`INSERT INTO agent_history_search_state
        (history_id,schema_version,indexed_rollout_ordinal) VALUES ($1,$2,$3)
        ON CONFLICT(history_id) DO UPDATE SET schema_version=excluded.schema_version,
        indexed_rollout_ordinal=excluded.indexed_rollout_ordinal`,
      [historyId, AGENT_HISTORY_SEARCH_SCHEMA_VERSION, ordinal]), 'Search watermark update failed')
      indexed = ordinal; applied += 1
    }
  }
  let lag: Array<{ count: unknown; watermark: unknown }>
  try { lag = await executor.select<Array<{ count: unknown; watermark: unknown }>>(`SELECT
    (SELECT COUNT(*) FROM agent_rollout_catalog c LEFT JOIN agent_history_search_state s ON s.history_id=c.history_id
      WHERE c.last_rollout_ordinal>COALESCE(s.indexed_rollout_ordinal,-1)) count,
    COALESCE((SELECT SUM(indexed_rollout_ordinal+1) FROM agent_history_search_state),0) watermark`) } catch (cause) {
    throw new MixedSearchIndexSqlError(cause)
  }
  return { eventsApplied: applied, lagging: derivedInteger(lag[0]?.count, 'lag count') > 0,
    watermark: derivedInteger(lag[0]?.watermark, 'total watermark') }
}
