import { DatabaseSync } from 'node:sqlite'

import { AgentHistoryError, encodeAgentRolloutRecord, type AgentHistoryTarget,
  type AgentRolloutRecordV1 } from '@einfach-agent/core/history'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { ensureRolloutProjectionSchema } from './projectionSchema'
import { createAgentHistorySearchIndex } from './searchIndex'

let database: DatabaseSync
let executor: ReturnType<typeof createSqliteExecutor>
const root = { kind: 'root', conversationId: 'conversation' } as const
const child = { kind: 'child', conversationId: 'conversation', runId: 'run', agentPath: 'root/research' } as const
function upsert(historyId: string, target: AgentHistoryTarget, ordinal: number, itemId: string,
  itemOrdinal: number, role: 'user' | 'assistant' | 'tool', content: string): AgentRolloutRecordV1 {
  const item = role === 'tool' ? { role, tool_call_id: 'call', content } as const : { role, content } as const
  return { schemaVersion: 1, historyId, rolloutOrdinal: ordinal,
    recordedAt: `2026-09-01T00:00:0${ordinal}.000Z`, mutationType: 'item_upsert', target,
    itemId, itemOrdinal, createdAt: itemOrdinal, item, pending: false, planStageId: null }
}
function catalog(historyId: string, target: AgentHistoryTarget, last: number, updated: number) {
  database.prepare(`INSERT INTO agent_rollout_catalog
    (history_id,target_kind,conversation_id,run_id,agent_path,updated_at,first_recorded_at,last_recorded_at,last_rollout_ordinal)
    VALUES (?,?,?,?,?,?, 'now','now',?)`).run(historyId, target.kind, target.conversationId,
    target.kind === 'child' ? target.runId : null, target.kind === 'child' ? target.agentPath : null, updated, last)
}
function event(value: AgentRolloutRecordV1) {
  database.prepare('INSERT INTO agent_rollout_events VALUES (?,?,?,?,?)').run(value.historyId, value.rolloutOrdinal,
    value.mutationType, value.recordedAt, encodeAgentRolloutRecord(value))
  if (value.mutationType === 'item_upsert') database.prepare(`INSERT INTO agent_rollout_items
    (history_id,item_id,item_ordinal,created_at,item_json,pending,plan_stage_id,deleted,last_change_ordinal)
    VALUES (?,?,?,?,?,0,NULL,0,?) ON CONFLICT(history_id,item_id) DO UPDATE SET
    item_ordinal=excluded.item_ordinal,item_json=excluded.item_json,deleted=0,last_change_ordinal=excluded.last_change_ordinal`)
    .run(value.historyId, value.itemId, value.itemOrdinal, value.createdAt, JSON.stringify(value.item), value.rolloutOrdinal)
  if (value.mutationType === 'item_deleted') database.prepare(`UPDATE agent_rollout_items SET deleted=1,
    last_change_ordinal=? WHERE history_id=? AND item_id=?`).run(value.rolloutOrdinal, value.historyId, value.itemId)
}
beforeEach(async () => {
  database = new DatabaseSync(':memory:'); executor = createSqliteExecutor(database, 'search-query')
  await ensureRolloutProjectionSchema(executor)
})
afterEach(() => database.close())

describe('history search query', () => {
  it('returns target, role, rank, bounded snippets and stable cursor pages', async () => {
    catalog('root-history', root, 1, 20); catalog('child-history', child, 0, 10)
    event(upsert('root-history', root, 0, 'root-user', 0, 'user', `needle ${'界'.repeat(2_000)}`))
    event(upsert('root-history', root, 1, 'root-tool', 1, 'tool', 'needle tool'))
    event(upsert('child-history', child, 0, 'child-user', 0, 'user', 'needle child'))
    const index = createAgentHistorySearchIndex(executor)
    const first = await index.search({ query: 'needle', roles: ['user'], limit: 1 })
    expect(first.hits).toHaveLength(1); expect(first.hits[0]).toMatchObject({ target: root, role: 'user' })
    expect(first.hits[0]!.snippet.length).toBeLessThanOrEqual(1_000)
    const second = await index.search({ query: 'needle', roles: ['user'], limit: 1, cursor: first.nextCursor })
    expect(second.hits).toHaveLength(1); expect(second.hits[0]!.itemId).not.toBe(first.hits[0]!.itemId)
    expect((await index.search({ query: 'needle', target: child })).hits.map(hit => hit.itemId)).toEqual(['child-user'])
    expect((await index.search({ query: 'needle', roles: ['tool'] })).hits.map(hit => hit.itemId)).toEqual(['root-tool'])
    expect(first.hits[0]!.rank).toEqual(expect.any(Number))
  })

  it('updates and deletes items, rejects stale cursors, and never uses a LIKE fallback', async () => {
    catalog('root-history', root, 1, 1)
    event(upsert('root-history', root, 0, 'item', 0, 'user', 'oldterm needle'))
    event(upsert('root-history', root, 1, 'other', 1, 'user', 'needle other'))
    const index = createAgentHistorySearchIndex(executor)
    const page = await index.search({ query: 'needle', limit: 1 })
    expect(page.nextCursor).toEqual(expect.any(String))
    const update = upsert('root-history', root, 2, 'item', 0, 'assistant', 'newterm needle')
    database.exec('UPDATE agent_rollout_catalog SET last_rollout_ordinal=2,updated_at=2'); event(update)
    const stale = await index.search({ query: 'needle', limit: 1, cursor: page.nextCursor })
      .catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(AgentHistoryError)
    expect((stale as AgentHistoryError).code).toBe('AGENT_HISTORY_CURSOR_STALE')
    expect((await index.search({ query: 'oldterm' })).hits).toEqual([])
    expect((await index.search({ query: 'newterm', roles: ['assistant'] })).hits).toHaveLength(1)
    const deleted: AgentRolloutRecordV1 = { schemaVersion: 1, historyId: 'root-history', rolloutOrdinal: 3,
      recordedAt: '2026-09-01T00:00:03.000Z', mutationType: 'item_deleted', target: root,
      itemId: 'item', reason: 'removed' }
    database.exec('UPDATE agent_rollout_catalog SET last_rollout_ordinal=3'); event(deleted)
    expect((await index.search({ query: 'newterm' })).hits).toEqual([])
    expect(JSON.stringify(await executor.select("SELECT sql FROM sqlite_master WHERE name='agent_history_search_fts'")))
      .not.toContain('LIKE')
  })

  it('returns explicit bounded lag and unavailable warnings', async () => {
    catalog('root-history', root, 1, 1)
    event(upsert('root-history', root, 0, 'one', 0, 'user', 'needle'))
    event(upsert('root-history', root, 1, 'two', 1, 'user', 'needle'))
    expect((await createAgentHistorySearchIndex(executor, { maxEvents: 1 }).search({ query: 'needle' })).warnings)
      .toContainEqual(expect.objectContaining({ code: 'SEARCH_INDEX_LAG' }))
    const unavailable = createAgentHistorySearchIndex({
      select: async <Rows>() => [{ enabled: 0 }] as Rows,
      execute: async () => ({ rowsAffected: 0 }),
    })
    expect(await unavailable.search({ query: 'needle' })).toEqual({ hits: [], warnings: [
      { code: 'SEARCH_INDEX_UNAVAILABLE', message: 'SQLite FTS5 is unavailable' },
    ] })
  })

  it('self-heals every derived hit field from canonical events', async () => {
    catalog('root-history', root, 0, 1); event(upsert('root-history', root, 0, 'item', 2, 'user', 'needle'))
    const index = createAgentHistorySearchIndex(executor); await index.search({ query: 'needle' })
    const mutations = [
      "UPDATE agent_history_search_fts SET content='wrong'",
      "UPDATE agent_history_search_fts SET history_id='wrong'",
      "UPDATE agent_history_search_fts SET item_id='wrong'",
      "UPDATE agent_history_search_fts SET role='tool'",
      'UPDATE agent_history_search_fts SET item_ordinal=99',
      'UPDATE agent_history_search_fts SET created_at=99',
    ]
    for (const sql of mutations) {
      database.exec(sql)
      await index.search({ query: sql.includes('content=') ? 'wrong' : 'needle' })
      const result = await index.search({ query: 'needle' })
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toMatchObject({ historyId: 'root-history', itemId: 'item', role: 'user',
        itemOrdinal: 2, createdAt: 2 })
    }
  })

  it('classifies malformed canonical item, target, identity, and flags as source corruption', async () => {
    catalog('root-history', root, 0, 1); event(upsert('root-history', root, 0, 'item', 0, 'user', 'needle'))
    const index = createAgentHistorySearchIndex(executor); await index.search({ query: 'needle' })
    const corruptions = [
      ["UPDATE agent_rollout_items SET item_json='{'", "UPDATE agent_rollout_items SET item_json='{" +
        '"role":"user","content":"needle"}' + "'"],
      ["UPDATE agent_rollout_catalog SET target_kind='child'", "UPDATE agent_rollout_catalog SET target_kind='root'"],
      ["UPDATE agent_rollout_items SET item_id=''; UPDATE agent_history_search_fts SET item_id=''",
        "UPDATE agent_rollout_items SET item_id='item'; UPDATE agent_history_search_fts SET item_id='item'"],
      ['UPDATE agent_rollout_items SET pending=2', 'UPDATE agent_rollout_items SET pending=0'],
    ]
    for (const [breakSql, restoreSql] of corruptions) {
      database.exec(breakSql!)
      const failure = await index.search({ query: 'needle' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AgentHistoryError)
      expect((failure as AgentHistoryError).code).toBe('AGENT_HISTORY_SOURCE_CORRUPT')
      database.exec(restoreSql!)
    }
  })

  it.each([
    { label: 'single hit', second: false },
    { label: 'cursor page', second: true },
  ])('validates canonical updatedAt for $label before returning output', async ({ second }) => {
    catalog('root-history', root, second ? 1 : 0, 1)
    event(upsert('root-history', root, 0, 'one', 0, 'user', 'needle'))
    if (second) event(upsert('root-history', root, 1, 'two', 1, 'user', 'needle'))
    const index = createAgentHistorySearchIndex(executor); await index.search({ query: 'needle' })
    for (const invalid of [-1, 0.5, 'bad']) {
      database.prepare('UPDATE agent_rollout_catalog SET updated_at=?').run(invalid)
      const failure = await index.search({ query: 'needle', ...(second ? { limit: 1 } : {}) })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AgentHistoryError)
      expect((failure as AgentHistoryError).code).toBe('AGENT_HISTORY_SOURCE_CORRUPT')
    }
  })
})
