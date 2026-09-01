import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  AGENT_ROLLOUT_MAX_LINE_BYTES,
  encodeAgentRolloutRecord,
  type AgentRolloutMutationV1,
  type AgentRolloutRecordV1,
} from '@einfach-agent/core/history'
import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { dropRolloutProjectionSchema } from './projectionSchema'
import { createRolloutProjector } from './projector'
import { RolloutProjectionError, RolloutSourceError } from './projector'

const target = { kind: 'root', conversationId: 'conversation-1' } as const
const childTarget = { kind: 'child', conversationId: 'conversation-1', runId: 'run-child', agentPath: 'root/research' } as const
let root: string | undefined
let database: DatabaseSync | undefined

function records(historyId: string, mutations: readonly AgentRolloutMutationV1[]): AgentRolloutRecordV1[] {
  return mutations.map((mutation, rolloutOrdinal) => ({
    ...mutation, schemaVersion: 1, historyId, rolloutOrdinal,
    recordedAt: `2026-09-01T00:00:0${rolloutOrdinal}.000Z`,
  }))
}

async function source(name: string, values: readonly AgentRolloutRecordV1[], suffix = '\n'): Promise<string> {
  const path = join(root!, name)
  await writeFile(path, `${values.map(encodeAgentRolloutRecord).join('\n')}${suffix}`)
  return path
}

async function rows<T>(sql: string): Promise<T> {
  return createSqliteExecutor(database!, 'projector-test').select<T>(sql)
}

async function projectionSnapshot() {
  return {
    catalog: await rows('SELECT * FROM agent_rollout_catalog ORDER BY history_id'),
    items: await rows('SELECT * FROM agent_rollout_items ORDER BY history_id,item_id'),
    turns: await rows('SELECT * FROM agent_rollout_turns ORDER BY history_id,turn_key'),
    events: await rows('SELECT * FROM agent_rollout_events ORDER BY history_id,rollout_ordinal'),
    state: await rows('SELECT * FROM agent_rollout_projection_state ORDER BY source_path'),
  }
}

afterEach(async () => {
  database?.close()
  database = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('rollout projector', () => {
  it('projects all mutations, updates/reorders/deletes items, and keeps event audit', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const values = records('history-root', [
      { mutationType: 'session_meta', target, title: 'Session', createdAt: 1, updatedAt: 2 },
      { mutationType: 'item_upsert', target, itemId: 'item-1', itemOrdinal: 0, createdAt: 3,
        item: { role: 'user', content: 'first' }, pending: false, planStageId: null },
      { mutationType: 'turn_context', target, turnId: 'turn-1', itemIds: ['item-1'] },
      { mutationType: 'item_upsert', target, itemId: 'item-1', itemOrdinal: 4, createdAt: 3,
        item: { role: 'user', content: 'updated' }, pending: true, planStageId: 'stage-1' },
      { mutationType: 'run_state', target, runId: 'run-1', turnId: 'turn-1', status: 'done', error: null },
      { mutationType: 'item_deleted', target, itemId: 'item-1', reason: 'removed' },
      { mutationType: 'run_state', target, runId: 'run-2', turnId: 'turn-2', status: 'running', error: null },
    ])
    const path = await source('root.jsonl', values)

    const result = await createRolloutProjector(createSqliteExecutor(database, 'projector-test')).reconcileHistory(path)
    expect(result).toMatchObject({ historyId: 'history-root', recordsApplied: 7 })
    expect(await rows('SELECT title,complete,last_rollout_ordinal FROM agent_rollout_catalog')).toEqual([
      { title: 'Session', complete: 0, last_rollout_ordinal: 6 },
    ])
    expect(await rows('SELECT item_ordinal,pending,plan_stage_id,deleted,delete_reason,item_json FROM agent_rollout_items')).toEqual([
      { item_ordinal: 4, pending: 1, plan_stage_id: 'stage-1', deleted: 1,
        delete_reason: 'removed', item_json: JSON.stringify({ role: 'user', content: 'updated' }) },
    ])
    expect(await rows('SELECT turn_id,item_ids_json,run_id,status FROM agent_rollout_turns ORDER BY turn_key')).toEqual([
      { turn_id: 'turn-1', item_ids_json: '["item-1"]', run_id: 'run-1', status: 'done' },
      { turn_id: 'turn-2', item_ids_json: null, run_id: 'run-2', status: 'running' },
    ])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_events')).toEqual([{ count: 7 }])
  })

  it('forces error brands from the active operation boundary', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-brand-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const executor = createSqliteExecutor(database, 'projector-brand-test')
    const path = join(root, 'source.jsonl')
    const sourceCause = new RolloutSourceError('misbranded executor')
    const projectionFailure = await createRolloutProjector({
      execute: async () => { throw sourceCause },
      select: async () => { throw sourceCause },
    }).reconcileHistory(path).catch((error: unknown) => error)
    expect(projectionFailure).toBeInstanceOf(RolloutProjectionError)
    expect((projectionFailure as Error).cause).toBe(sourceCause)

    const validPath = await source('brand.jsonl', records('history-brand', [
      { mutationType: 'session_meta', target, title: 'Brand', createdAt: 1, updatedAt: 1 },
    ]))
    const hookFailure = await createRolloutProjector(executor, {
      afterRecordUpsert() { throw sourceCause },
    }).reconcileHistory(validPath).catch((error: unknown) => error)
    expect(hookFailure).toBeInstanceOf(RolloutProjectionError)
    expect((hookFailure as Error).cause).toBe(sourceCause)

    const projectionCause = new RolloutProjectionError('misbranded source')
    const sourceFailure = await createRolloutProjector(executor, {
      beforeSourceRead() { throw projectionCause },
    }).reconcileHistory(path).catch((error: unknown) => error)
    expect(sourceFailure).toBeInstanceOf(RolloutSourceError)
    expect((sourceFailure as Error).cause).toBe(projectionCause)
  })

  it('fixes history and complete target identity across chunks and later reconciles', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-identity-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const executor = createSqliteExecutor(database, 'projector-identity-test')
    const first = records('history-fixed', [
      { mutationType: 'session_meta', target, title: 'Fixed', createdAt: 1, updatedAt: 1 },
    ])[0]!
    const mixedHistory = records('history-other', [
      { mutationType: 'run_state', target, runId: 'run', turnId: null, status: 'running', error: null },
    ])[0]!
    const mixedFirst = { ...first, historyId: 'history-mixed' }
    const mixedPath = await source('mixed.jsonl', [mixedFirst, { ...mixedHistory, rolloutOrdinal: 1 }])
    await expect(createRolloutProjector(executor, { readChunkBytes: 7 }).reconcileHistory(mixedPath))
      .rejects.toBeInstanceOf(RolloutSourceError)

    const stablePath = await source('stable.jsonl', [first])
    const projector = createRolloutProjector(executor, { readChunkBytes: 5 })
    await projector.reconcileHistory(stablePath)
    const drifted = { ...records('history-fixed', [
      { mutationType: 'run_state', target: childTarget, runId: 'run-child', turnId: null,
        status: 'running', error: null },
    ])[0]!, rolloutOrdinal: 1 }
    await appendFile(stablePath, `${encodeAgentRolloutRecord(drifted)}\n`)
    await expect(projector.reconcileHistory(stablePath))
      .rejects.toBeInstanceOf(RolloutSourceError)
    expect(await rows('SELECT history_id,target_kind FROM agent_rollout_catalog ORDER BY history_id')).toEqual([
      { history_id: 'history-fixed', target_kind: 'root' },
      { history_id: 'history-mixed', target_kind: 'root' },
    ])
  })

  it('rejects a newline-terminated oversized line before any projection advances', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-line-limit-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const path = join(root, 'oversized.jsonl')
    await writeFile(path, `${'x'.repeat(AGENT_ROLLOUT_MAX_LINE_BYTES + 1)}\n`)
    const projector = createRolloutProjector(
      createSqliteExecutor(database, 'projector-line-limit-test'),
      { readChunkBytes: 4_097 },
    )
    await expect(projector.reconcileHistory(path)).rejects.toThrow(
      `rollout line exceeds maximum size at ${path}:0`,
    )
    await expect(projector.reconcileHistory(path)).rejects.toBeInstanceOf(RolloutSourceError)
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_catalog')).toEqual([{ count: 0 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_events')).toEqual([{ count: 0 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_items')).toEqual([{ count: 0 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_turns')).toEqual([{ count: 0 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_projection_state')).toEqual([{ count: 0 }])
  })

  it('replays a real file after crashing between upsert and offset without duplicates', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-crash-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const path = await source('crash.jsonl', records('history-crash', [
      { mutationType: 'item_upsert', target, itemId: 'item-1', itemOrdinal: 0, createdAt: 1,
        item: { role: 'assistant', content: 'durable' }, pending: false, planStageId: null },
    ]))
    const executor = createSqliteExecutor(database, 'projector-crash-test')
    const crashing = createRolloutProjector(executor, { afterRecordUpsert() { throw new Error('simulated crash') } })
    await expect(crashing.reconcileHistory(path)).rejects.toBeInstanceOf(RolloutProjectionError)
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_items')).toEqual([{ count: 1 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_events')).toEqual([{ count: 1 }])

    await expect(createRolloutProjector(executor).reconcileHistory(path)).resolves.toMatchObject({ recordsApplied: 1 })
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_items')).toEqual([{ count: 1 }])
    expect(await rows('SELECT COUNT(*) AS count FROM agent_rollout_events')).toEqual([{ count: 1 }])
  })

  it('tracks histories independently, leaves partial lines pending, and rebuilds from JSONL', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-projector-rebuild-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const first = await source('first.jsonl', records('history-first', [
      { mutationType: 'session_meta', target, title: 'Root', createdAt: 1, updatedAt: 1 },
    ]))
    const secondValues = records('history-second', [
      { mutationType: 'session_meta', target: childTarget, title: 'Child', createdAt: 2, updatedAt: 2 },
      { mutationType: 'item_upsert', target: childTarget, itemId: 'item-1', itemOrdinal: 0, createdAt: 3,
        item: { role: 'user', content: 'first' }, pending: false, planStageId: null },
      { mutationType: 'turn_context', target: childTarget, turnId: 'turn-1', itemIds: ['item-1'] },
      { mutationType: 'item_upsert', target: childTarget, itemId: 'item-1', itemOrdinal: 2, createdAt: 3,
        item: { role: 'user', content: 'updated' }, pending: true, planStageId: 'stage' },
      { mutationType: 'run_state', target: childTarget, runId: 'run-child', turnId: 'turn-1', status: 'done', error: null },
      { mutationType: 'item_deleted', target: childTarget, itemId: 'item-1', reason: 'removed' },
    ])
    const completeLines = `${secondValues.slice(0, -1).map(encodeAgentRolloutRecord).join('\n')}\n`
    const second = await source('second.jsonl', secondValues, '')
    const executor = createSqliteExecutor(database, 'projector-rebuild-test')
    const projector = createRolloutProjector(executor, { readChunkBytes: 11 })
    await projector.reconcileHistory(first)
    const partial = await projector.reconcileHistory(second)
    expect(partial).toMatchObject({ historyId: 'history-second', recordsApplied: 5,
      nextByteOffset: Buffer.byteLength(completeLines), warning: { kind: 'source', code: 'ROLLOUT_PARTIAL_LINE' } })
    expect(partial.warning?.message).toContain(`${second}:${Buffer.byteLength(completeLines)}`)

    await writeFile(second, `${secondValues.map(encodeAgentRolloutRecord).join('\n')}\n`)
    await projector.reconcileHistory(second)
    const before = await projectionSnapshot()

    await dropRolloutProjectionSchema(executor)
    const rebuilt = createRolloutProjector(executor)
    await rebuilt.reconcileHistory(first)
    await rebuilt.reconcileHistory(second)
    expect(await projectionSnapshot()).toEqual(before)
  })
})
