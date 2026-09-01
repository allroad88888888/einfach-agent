import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { derivedSearchFailure } from './searchIndexFailure'

export const AGENT_HISTORY_SEARCH_SCHEMA_VERSION = 1
export const AGENT_HISTORY_SEARCH_TABLES = [
  'agent_history_search_fts',
  'agent_history_search_state',
] as const

const CREATE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS agent_history_search_fts USING fts5(
  content, history_id UNINDEXED, item_id UNINDEXED, role UNINDEXED,
  item_ordinal UNINDEXED, created_at UNINDEXED, updated_at UNINDEXED
)`
const PROBE_HISTORY = '__agent_history_search_probe__'
async function create(executor: SqlExecutor): Promise<void> {
  await executor.execute(CREATE_FTS)
  await executor.execute(`CREATE TABLE IF NOT EXISTS agent_history_search_state (
    history_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    indexed_rollout_ordinal INTEGER NOT NULL
  )`)
}

/** Exercises state columns plus an actual FTS insert/MATCH/delete cycle. */
export async function probeAgentHistorySearchSchema(executor: SqlExecutor): Promise<void> {
  try {
    await executor.execute(`INSERT INTO agent_history_search_state
      (history_id,schema_version,indexed_rollout_ordinal) VALUES ($1,$2,-1)
      ON CONFLICT(history_id) DO UPDATE SET schema_version=excluded.schema_version,
      indexed_rollout_ordinal=excluded.indexed_rollout_ordinal`,
    [PROBE_HISTORY, AGENT_HISTORY_SEARCH_SCHEMA_VERSION])
    await executor.execute(`INSERT INTO agent_history_search_fts
      (content,history_id,item_id,role,item_ordinal,created_at,updated_at)
      VALUES ('searchprobe',$1,'probe','system',0,0,0)`, [PROBE_HISTORY])
    const rows = await executor.select<Array<{ count: unknown }>>(
      "SELECT COUNT(*) count FROM agent_history_search_fts WHERE agent_history_search_fts MATCH 'searchprobe' AND history_id=$1",
      [PROBE_HISTORY])
    if (rows[0]?.count !== 1) throw new Error('FTS5 probe row was not matched')
    await executor.execute('DELETE FROM agent_history_search_fts WHERE history_id=$1', [PROBE_HISTORY])
    await executor.execute('DELETE FROM agent_history_search_state WHERE history_id=$1', [PROBE_HISTORY])
  } catch (cause) { throw derivedSearchFailure('History search active probe failed', cause) }
}

/** Probes the runtime and creates only the disposable search projection. */
export async function ensureAgentHistorySearchSchema(executor: SqlExecutor): Promise<boolean> {
  const rows = await executor.select<Array<{ enabled: unknown }>>(
    "SELECT sqlite_compileoption_used('ENABLE_FTS5') enabled",
  )
  if (rows[0]?.enabled !== 1) return false
  try {
    await create(executor); await probeAgentHistorySearchSchema(executor)
    return true
  } catch {
    await dropAgentHistorySearchSchema(executor).catch(() => undefined)
    try { await create(executor); await probeAgentHistorySearchSchema(executor); return true } catch {
      await dropAgentHistorySearchSchema(executor).catch(() => undefined)
      return false
    }
  }
}

/** Drops the FTS table (including its shadow tables) and its watermarks only. */
export async function dropAgentHistorySearchSchema(executor: SqlExecutor): Promise<void> {
  await executor.execute('DROP TABLE IF EXISTS agent_history_search_fts')
  await executor.execute('DROP TABLE IF EXISTS agent_history_search_state')
}
