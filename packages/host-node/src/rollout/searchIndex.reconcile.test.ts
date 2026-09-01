import { DatabaseSync } from 'node:sqlite'

import { encodeAgentRolloutRecord, type AgentRolloutRecordV1 } from '@einfach-agent/core/history'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'
import { ensureRolloutProjectionSchema } from './projectionSchema'
import { reconcileAgentHistorySearch } from './searchReconciler'
import { dropAgentHistorySearchSchema, ensureAgentHistorySearchSchema } from './searchSchema'
import { createAgentHistorySearchIndex } from './searchIndex'

const target = { kind: 'root', conversationId: 'conversation' } as const
let database: DatabaseSync
let executor: ReturnType<typeof createSqliteExecutor>
function record(ordinal: number, content?: string): AgentRolloutRecordV1 {
  return content === undefined
    ? { schemaVersion: 1, historyId: 'history', rolloutOrdinal: ordinal,
      recordedAt: `2026-09-01T00:00:0${ordinal}.000Z`, mutationType: 'run_state', target,
      runId: null, turnId: null, status: 'running', error: null }
    : { schemaVersion: 1, historyId: 'history', rolloutOrdinal: ordinal,
      recordedAt: `2026-09-01T00:00:0${ordinal}.000Z`, mutationType: 'item_upsert', target,
      itemId: 'item', itemOrdinal: ordinal, createdAt: ordinal, item: { role: 'user', content },
      pending: false, planStageId: null }
}
async function seed(records: readonly AgentRolloutRecordV1[]) {
  database.prepare(`INSERT OR REPLACE INTO agent_rollout_catalog
    (history_id,target_kind,conversation_id,first_recorded_at,last_recorded_at,last_rollout_ordinal)
    VALUES ('history','root','conversation','now','now',?)`).run(records.at(-1)!.rolloutOrdinal)
  const statement = database.prepare('INSERT INTO agent_rollout_events VALUES (?,?,?,?,?)')
  for (const event of records) statement.run(event.historyId, event.rolloutOrdinal, event.mutationType,
    event.recordedAt, encodeAgentRolloutRecord(event))
}
beforeEach(async () => {
  database = new DatabaseSync(':memory:'); executor = createSqliteExecutor(database, 'search-reconcile')
  await ensureRolloutProjectionSchema(executor); expect(await ensureAgentHistorySearchSchema(executor)).toBe(true)
})
afterEach(() => database.close())

describe('history search reconciliation', () => {
  it('is bounded, reports lag, advances run-only watermarks, and catches up', async () => {
    await seed([record(0, 'first'), record(1), record(2, 'latest')])
    const first = await reconcileAgentHistorySearch(executor, { maxEvents: 1 })
    expect(first).toMatchObject({ eventsApplied: 1, lagging: true, watermark: 1 })
    expect(await reconcileAgentHistorySearch(executor, { maxEvents: 1 }))
      .toMatchObject({ eventsApplied: 1, lagging: true, watermark: 2 })
    expect(await reconcileAgentHistorySearch(executor, { maxEvents: 1 }))
      .toMatchObject({ eventsApplied: 1, lagging: false, watermark: 3 })
    expect(await executor.select('SELECT content,item_ordinal FROM agent_history_search_fts'))
      .toEqual([{ content: 'latest', item_ordinal: 2 }])
    expect(await reconcileAgentHistorySearch(executor)).toMatchObject({ eventsApplied: 0, lagging: false })
  })

  it('replays idempotently when failure occurs after mutation but before watermark', async () => {
    await seed([record(0, 'retry')]); let failed = false
    await expect(reconcileAgentHistorySearch(executor, { afterMutation() {
      if (!failed) { failed = true; throw new Error('crash') }
    } })).rejects.toThrow('crash')
    expect(await executor.select('SELECT COUNT(*) count FROM agent_history_search_fts')).toEqual([{ count: 1 }])
    expect(await executor.select('SELECT * FROM agent_history_search_state')).toEqual([])
    expect(await reconcileAgentHistorySearch(executor)).toMatchObject({ eventsApplied: 1, lagging: false })
    expect(await executor.select('SELECT COUNT(*) count FROM agent_history_search_fts')).toEqual([{ count: 1 }])
  })

  it('rebuilds after drop and after schema-version mismatch', async () => {
    await seed([record(0, 'rebuild')]); await reconcileAgentHistorySearch(executor)
    await dropAgentHistorySearchSchema(executor); await ensureAgentHistorySearchSchema(executor)
    await reconcileAgentHistorySearch(executor)
    expect(await executor.select('SELECT content FROM agent_history_search_fts')).toEqual([{ content: 'rebuild' }])
    database.exec('UPDATE agent_history_search_state SET schema_version=999')
    expect(await createAgentHistorySearchIndex(executor).reconcile()).toMatchObject({ eventsApplied: 1, lagging: false })
    expect(await executor.select('SELECT COUNT(*) count FROM agent_history_search_fts')).toEqual([{ count: 1 }])
  })

  it.each([-2, 0.5, 'bad'])('treats invalid derived watermark %s as rebuildable', async value => {
    await seed([record(0, 'watermark')]); const index = createAgentHistorySearchIndex(executor)
    await index.reconcile()
    database.prepare('UPDATE agent_history_search_state SET indexed_rollout_ordinal=?').run(value)
    expect(await index.reconcile()).toMatchObject({ available: true, lagging: false, eventsApplied: 1 })
    expect(await executor.select('SELECT content FROM agent_history_search_fts')).toEqual([{ content: 'watermark' }])
    expect(await executor.select('SELECT COUNT(*) count FROM agent_rollout_catalog')).toEqual([{ count: 1 }])
  })

  it.each(['SELECT c.history_id,c.last_rollout_ordinal', '(SELECT COUNT(*) FROM agent_rollout_catalog'])
  ('attributes an ensure-to-reconcile state race at %s to the derived index', async trigger => {
    await seed([record(0, 'race')]); let sabotaged = false
    const racing: SqlExecutor = {
      execute: (sql, params) => executor.execute(sql, params),
      async select<Rows>(sql: string, params?: unknown[]): Promise<Rows> {
        if (!sabotaged && sql.includes(trigger)) {
          sabotaged = true; database.exec('DROP TABLE agent_history_search_state')
        }
        return executor.select<Rows>(sql, params)
      },
    }
    const result = await createAgentHistorySearchIndex(racing).reconcile()
    expect(result).toMatchObject({ available: true, lagging: false, eventsApplied: 1 })
    expect(await executor.select('SELECT content FROM agent_history_search_fts')).toEqual([{ content: 'race' }])
  })

  it('keeps an invalid canonical catalog ordinal source-corrupt', async () => {
    await seed([record(0, 'canonical')]); database.exec('UPDATE agent_rollout_catalog SET last_rollout_ordinal=-2')
    const failure = await createAgentHistorySearchIndex(executor).reconcile().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
  })

  it.each([
    { trigger: 'WHERE schema_version<>', rows: [{ count: -1 }] },
    { trigger: 'COALESCE((SELECT SUM', rows: [{ count: 'bad', watermark: 0 }] },
    { trigger: 'COALESCE((SELECT SUM', rows: [{ count: 0, watermark: 0.5 }] },
  ])('treats invalid state aggregate decode as derived: $rows', async ({ trigger, rows }) => {
    await seed([record(0, 'aggregate')]); let injected = false
    const controlled: SqlExecutor = {
      execute: (sql, params) => executor.execute(sql, params),
      async select<Rows>(sql: string, params?: unknown[]): Promise<Rows> {
        if (!injected && sql.includes(trigger)) { injected = true; return rows as Rows }
        return executor.select<Rows>(sql, params)
      },
    }
    expect(await createAgentHistorySearchIndex(controlled).reconcile())
      .toMatchObject({ available: true, lagging: false, eventsApplied: 1 })
    expect(await executor.select('SELECT content FROM agent_history_search_fts')).toEqual([{ content: 'aggregate' }])
  })
})
