import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { dropAgentHistorySearchSchema, ensureAgentHistorySearchSchema } from './searchSchema'

let database: DatabaseSync | undefined
afterEach(() => { database?.close(); database = undefined })

describe('history search schema', () => {
  it('probes real FTS5, creates the virtual table, and drops only search tables', async () => {
    database = new DatabaseSync(':memory:'); database.exec('CREATE TABLE preserved(value TEXT)')
    const executor = createSqliteExecutor(database, 'search-schema')
    expect(await ensureAgentHistorySearchSchema(executor)).toBe(true)
    expect(await executor.select("SELECT name FROM sqlite_master WHERE name LIKE 'agent_history_search_%' ORDER BY name"))
      .toEqual(expect.arrayContaining([{ name: 'agent_history_search_fts' }, { name: 'agent_history_search_state' }]))
    await dropAgentHistorySearchSchema(executor)
    expect(await executor.select("SELECT name FROM sqlite_master WHERE name='preserved'")).toEqual([{ name: 'preserved' }])
    expect(await executor.select("SELECT name FROM sqlite_master WHERE name LIKE 'agent_history_search_%'" )).toEqual([])
  })

  it('returns unavailable without attempting a LIKE fallback', async () => {
    const statements: string[] = []
    const available = await ensureAgentHistorySearchSchema({
      select: async <Rows>() => [{ enabled: 0 }] as Rows,
      execute: async sql => { statements.push(sql); return { rowsAffected: 0 } },
    })
    expect(available).toBe(false)
    expect(statements).toEqual([])
  })

  it('repairs an incompatible state schema through drop and recreate', async () => {
    database = new DatabaseSync(':memory:'); const executor = createSqliteExecutor(database, 'search-schema-repair')
    database.exec('CREATE TABLE agent_history_search_state(history_id TEXT PRIMARY KEY, wrong TEXT)')
    expect(await ensureAgentHistorySearchSchema(executor)).toBe(true)
    expect(await executor.select('PRAGMA table_info(agent_history_search_state)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'schema_version' }), expect.objectContaining({ name: 'indexed_rollout_ordinal' }),
    ]))
  })

  it('detects a damaged FTS shadow table without touching unrelated tables', async () => {
    database = new DatabaseSync(':memory:'); const executor = createSqliteExecutor(database, 'search-shadow')
    database.exec('CREATE TABLE preserved(value TEXT)'); expect(await ensureAgentHistorySearchSchema(executor)).toBe(true)
    database.enableDefensive(false)
    database.exec("PRAGMA writable_schema=ON; DELETE FROM sqlite_master WHERE name='agent_history_search_fts_idx'; PRAGMA writable_schema=OFF; PRAGMA schema_version=999")
    expect(await ensureAgentHistorySearchSchema(executor)).toBe(true)
    expect(await executor.select("SELECT name FROM sqlite_master WHERE name='agent_history_search_fts_idx'"))
      .toEqual([{ name: 'agent_history_search_fts_idx' }])
    expect(await executor.select("SELECT name FROM sqlite_master WHERE name='preserved'")).toEqual([{ name: 'preserved' }])
  })
})
