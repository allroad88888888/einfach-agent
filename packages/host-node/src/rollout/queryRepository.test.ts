import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHistoryTarget } from '@einfach-agent/core/history'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { ensureRolloutProjectionSchema } from './projectionSchema'
import { createRolloutQueryRepository } from './queryRepository'

const root = { kind: 'root', conversationId: 'conversation-a' } as const
const child = { kind: 'child', conversationId: 'conversation-b', runId: 'run-child', agentPath: 'root/research' } as const
let database: DatabaseSync

function run(sql: string, ...params: unknown[]) { database.prepare(sql).run(...params as never[]) }
function meta(historyId: string, target: AgentHistoryTarget, title: string, updatedAt: number, complete = 0) {
  run(`INSERT INTO agent_rollout_catalog
    (history_id,target_kind,conversation_id,run_id,agent_path,title,created_at,updated_at,
     first_recorded_at,last_recorded_at,complete,last_rollout_ordinal)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, historyId, target.kind, target.conversationId,
  target.kind === 'child' ? target.runId : null, target.kind === 'child' ? target.agentPath : null,
  title, updatedAt - 1, updatedAt, 'first', 'last', complete, 2)
  run('INSERT INTO agent_rollout_events VALUES (?,?,?,?,?)', historyId, 0, 'session_meta', 'now', '{}')
}
function item(historyId: string, id: string, ordinal: number, value: unknown, deleted = 0) {
  run(`INSERT INTO agent_rollout_items
    (history_id,item_id,item_ordinal,created_at,item_json,pending,plan_stage_id,deleted,delete_reason,last_change_ordinal)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, historyId, id, ordinal, ordinal + 10, JSON.stringify(value),
  id === 'pending' ? 1 : 0, id === 'pending' ? 'stage' : null, deleted, deleted ? 'gone' : null, 1)
}

beforeEach(async () => {
  database = new DatabaseSync(':memory:')
  await ensureRolloutProjectionSchema(createSqliteExecutor(database, 'query-test'))
})
afterEach(() => database.close())

describe('rollout query repository', () => {
  it('lists global root and child histories with stable status pagination', async () => {
    meta('root-history', root, 'Root', 10)
    meta('child-history', child, 'Child', 20, 1)
    run('INSERT INTO agent_rollout_turns VALUES (?,?,?,?,?,?,?,?)', 'root-history', 'turn', 'turn', null, 'run', 'running', null, 1)
    run('INSERT INTO agent_rollout_turns VALUES (?,?,?,?,?,?,?,?)', 'child-history', 'turn', 'turn', null, 'run-child', 'done', null, 2)
    item('root-history', 'visible', 0, { role: 'user', content: 'hi' })
    item('root-history', 'deleted', 1, { role: 'assistant', content: 'bye' }, 1)
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const first = await repository.listHistories({ limit: 1 })
    expect(first.histories).toEqual([expect.objectContaining({ historyId: 'child-history', target: child,
      status: 'done', complete: true, itemCount: 0 })])
    expect((await repository.listHistories({ limit: 1, cursor: first.nextCursor })).histories)
      .toEqual([expect.objectContaining({ historyId: 'root-history', status: 'running', complete: false })])
    expect((await repository.listHistories({ statuses: ['running'] })).histories.map(row => row.historyId))
      .toEqual(['root-history'])
    expect((await repository.listHistories({ target: root })).histories[0]?.itemCount).toBe(1)
    run('INSERT INTO agent_rollout_events VALUES (?,?,?,?,?)', 'root-history', 1, 'run_state', 'later', '{}')
    await expect(repository.listHistories({ limit: 1, cursor: first.nextCursor })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_CURSOR_STALE' })
  })

  it('paginates items, excludes tombstones, and detects target changes', async () => {
    meta('root-history', root, 'Root', 10)
    item('root-history', 'first', 0, { role: 'user', content: 'first' })
    item('root-history', 'pending', 1, { role: 'assistant', content: 'second' })
    item('root-history', 'deleted', 2, { role: 'tool', content: 'hidden', tool_call_id: 'call' }, 1)
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const first = await repository.listItems({ target: root, limit: 1 })
    expect(first.items[0]).toMatchObject({ itemId: 'first', materialized: true,
      role: 'user', preview: 'first', deleted: false })
    expect((await repository.listItems({ target: root, limit: 1, cursor: first.nextCursor })).items[0])
      .toMatchObject({ itemId: 'pending', pending: true, planStageId: 'stage' })
    expect((await repository.listItems({ target: root, includeDeleted: true })).items).toHaveLength(3)
    run('UPDATE agent_rollout_catalog SET last_rollout_ordinal=3 WHERE history_id=?', 'root-history')
    await expect(repository.listItems({ target: root, limit: 1, cursor: first.nextCursor })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_CURSOR_STALE' })
  })

  it('filters normalized roles across bounded scan batches and stable pages', async () => {
    meta('root-history', root, 'Root', 10)
    for (let index = 0; index < 105; index += 1) {
      item('root-history', `system-${String(index).padStart(3, '0')}`, index, { role: 'system', content: 'skip' })
    }
    item('root-history', 'user', 105, { role: 'user', content: 'keep user' })
    item('root-history', 'tool', 106, { role: 'tool', content: 'keep tool', tool_call_id: 'call' })
    item('root-history', 'assistant', 107, { role: 'assistant', content: 'keep assistant' })
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const first = await repository.listItems({ target: root, roles: ['tool', 'user', 'tool'], limit: 1 })
    expect(first.items.map(value => value.itemId)).toEqual(['user'])
    const second = await repository.listItems({ target: root, roles: ['user', 'tool'], limit: 1,
      cursor: first.nextCursor })
    expect(second.items.map(value => value.itemId)).toEqual(['tool'])
    await expect(repository.listItems({ target: root, roles: ['assistant'], cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'AGENT_HISTORY_INVALID_CURSOR' })
  })

  it('returns an empty bounded-scan page that advances to a match beyond the cap', async () => {
    meta('root-history', root, 'Root', 10)
    for (let index = 0; index < 201; index += 1) {
      item('root-history', `system-${index}`, index, { role: 'system', content: 'skip' })
    }
    item('root-history', 'eventual-user', 201, { role: 'user', content: 'found' })
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const first = await repository.listItems({ target: root, roles: ['user'], limit: 1 })
    expect(first.items).toEqual([])
    expect(first.warnings).toEqual([expect.objectContaining({
      code: 'OUTPUT_TRUNCATED', message: expect.stringContaining('bounded'),
    })])
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(100_000)
    const second = await repository.listItems({ target: root, roles: ['user'], limit: 1,
      cursor: first.nextCursor })
    expect(second.items.map(value => value.itemId)).toEqual(['eventual-user'])
  })

  it('uses the scanned watermark only after returning every match inside the cap', async () => {
    meta('root-history', root, 'Root', 10)
    for (let index = 0; index < 202; index += 1) {
      const role = index === 50 || index === 201 ? 'user' : 'system'
      item('root-history', `item-${String(index).padStart(3, '0')}`, index, { role, content: role })
    }
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const first = await repository.listItems({ target: root, roles: ['user'], limit: 1 })
    expect(first.items.map(value => value.itemId)).toEqual(['item-050'])
    expect(first.warnings).toEqual([expect.objectContaining({ code: 'OUTPUT_TRUNCATED' })])
    const second = await repository.listItems({ target: root, roles: ['user'], limit: 1,
      cursor: first.nextCursor })
    expect(second.items.map(value => value.itemId)).toEqual(['item-201'])
  })

  it('caps serialized item pages and returns a continuation warning', async () => {
    meta('root-history', root, 'Root', 10)
    for (let index = 0; index < 60; index += 1) {
      item('root-history', `item-${String(index).padStart(2, '0')}`, index,
        { role: 'user', content: '界'.repeat(2_000) })
    }
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    const page = await repository.listItems({ target: root, limit: 100 })
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(100_000)
    expect(page.warnings).toEqual([expect.objectContaining({ code: 'OUTPUT_TRUNCATED' })])
    expect(page.nextCursor).toBeTypeOf('string')
  })

  it('budgets full identity/cursor envelopes and treats oversized TEXT as a bounded request error', async () => {
    meta('root-history', root, 'x'.repeat(100_001), 10)
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    await expect(repository.listHistories({})).rejects.toBeInstanceOf(RangeError)
    await expect(repository.listItems({ target: root })).rejects.toBeInstanceOf(RangeError)
  })

  it('includes normalized target cursor overhead in the final item envelope budget', async () => {
    const largeChild = { kind: 'child', conversationId: 'conversation', runId: 'run',
      agentPath: 'p'.repeat(55_000) } as const
    meta('large-child', largeChild, 'Child', 10)
    item('large-child', 'one', 0, { role: 'user', content: 'one' })
    item('large-child', 'two', 1, { role: 'user', content: 'two' })
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    await expect(repository.listItems({ target: largeChild, limit: 1 })).rejects.toBeInstanceOf(RangeError)
  })

  it('fails closed for invalid canonical status and completion state', async () => {
    meta('root-history', root, 'Root', 10)
    run('INSERT INTO agent_rollout_turns VALUES (?,?,?,?,?,?,?,?)', 'root-history', 'turn', 'turn', null,
      'run', 'invented', null, 1)
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    await expect(repository.listHistories({})).rejects.toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
    run("UPDATE agent_rollout_turns SET status='idle'")
    run('UPDATE agent_rollout_catalog SET complete=2')
    await expect(repository.listHistories({})).rejects.toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
  })

  it('reads Unicode JSON in bounded code-point chunks and distinguishes deleted items', async () => {
    meta('root-history', root, 'Root', 10)
    item('root-history', 'unicode', 0, { role: 'user', content: '甲😀乙' })
    item('root-history', 'deleted', 1, { role: 'user', content: 'gone' }, 1)
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    let offset = 0; let joined = ''; let result
    do {
      result = await repository.readItem({ target: root, itemId: 'unicode', offset, limit: 2 })
      joined += result.text; offset = result.nextOffset ?? result.totalChars
    } while (result.nextOffset !== undefined)
    expect(joined).toBe(JSON.stringify({ role: 'user', content: '甲😀乙' }))
    await expect(repository.readItem({ target: root, itemId: 'deleted' })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_ITEM_DELETED' })
    await expect(repository.readItem({ target: root, itemId: 'missing' })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_ITEM_NOT_FOUND' })
  })

  it('fails closed for corrupt identity and oversized or invalid items', async () => {
    meta('bad-history', root, 'Bad', 10)
    run("UPDATE agent_rollout_catalog SET target_kind='child' WHERE history_id='bad-history'")
    const repository = createRolloutQueryRepository(createSqliteExecutor(database, 'query-test'))
    await expect(repository.listHistories({})).rejects.toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
    run("UPDATE agent_rollout_catalog SET target_kind='root' WHERE history_id='bad-history'")
    item('bad-history', 'bad', 0, { nope: true })
    await expect(repository.listItems({ target: root })).rejects.toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
    run("UPDATE agent_rollout_items SET item_json=? WHERE item_id='bad'", JSON.stringify({ role: 'user', content: 'x'.repeat(1_048_577) }))
    await expect(repository.readItem({ target: root, itemId: 'bad' })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
    run("UPDATE agent_rollout_items SET deleted=2 WHERE item_id='bad'")
    await expect(repository.readItem({ target: root, itemId: 'bad' })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
  })
})
