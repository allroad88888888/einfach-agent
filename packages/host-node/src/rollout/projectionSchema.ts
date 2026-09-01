import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

export const AGENT_ROLLOUT_PROJECTION_TABLES = [
  'agent_rollout_projection_state',
  'agent_rollout_turns',
  'agent_rollout_items',
  'agent_rollout_events',
  'agent_rollout_catalog',
] as const

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_rollout_catalog (
    history_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    run_id TEXT,
    agent_path TEXT,
    title TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    first_recorded_at TEXT NOT NULL,
    last_recorded_at TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    last_rollout_ordinal INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_rollout_events (
    history_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    mutation_type TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (history_id, rollout_ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_rollout_items (
    history_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_ordinal INTEGER,
    created_at INTEGER,
    item_json TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    plan_stage_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    delete_reason TEXT,
    last_change_ordinal INTEGER NOT NULL,
    PRIMARY KEY (history_id, item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_rollout_turns (
    history_id TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    turn_id TEXT,
    item_ids_json TEXT,
    run_id TEXT,
    status TEXT,
    error TEXT,
    last_change_ordinal INTEGER NOT NULL,
    PRIMARY KEY (history_id, turn_key)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_rollout_projection_state (
    source_path TEXT PRIMARY KEY,
    history_id TEXT NOT NULL UNIQUE,
    next_byte_offset INTEGER NOT NULL,
    next_rollout_ordinal INTEGER NOT NULL
  )`,
] as const

/** Creates the disposable query projection one atomic DDL statement at a time. */
export async function ensureRolloutProjectionSchema(executor: SqlExecutor): Promise<void> {
  for (const statement of CREATE_STATEMENTS) await executor.execute(statement)
}

/** Drops only rollout projection tables; the JSONL source is deliberately untouched. */
export async function dropRolloutProjectionSchema(executor: SqlExecutor): Promise<void> {
  for (const table of AGENT_ROLLOUT_PROJECTION_TABLES) {
    await executor.execute(`DROP TABLE IF EXISTS ${table}`)
  }
}
