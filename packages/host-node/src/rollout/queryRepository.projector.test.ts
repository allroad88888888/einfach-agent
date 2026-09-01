import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeAgentRolloutRecord, type AgentRolloutMutationV1, type AgentRolloutRecordV1,
} from '@einfach-agent/core/history'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { createRolloutProjector } from './projector'
import { createRolloutQueryRepository } from './queryRepository'

const target = { kind: 'root', conversationId: 'projected-conversation' } as const
let directory: string | undefined
let database: DatabaseSync | undefined

function records(historyId: string, mutations: readonly AgentRolloutMutationV1[]): AgentRolloutRecordV1[] {
  return mutations.map((mutation, rolloutOrdinal) => ({ ...mutation, schemaVersion: 1,
    historyId, rolloutOrdinal, recordedAt: `2026-09-01T00:00:${String(rolloutOrdinal).padStart(2, '0')}.000Z` }))
}

afterEach(async () => {
  database?.close(); database = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('rollout query repository with projector', () => {
  it('represents unknown and materialized tombstones with nullable stable continuation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'query-projector-'))
    database = new DatabaseSync(join(directory, 'projection.db'))
    const executor = createSqliteExecutor(database, 'query-projector-test')
    const values = records('projected-history', [
      { mutationType: 'session_meta', target, title: 'Projected', createdAt: 1, updatedAt: 2 },
      { mutationType: 'item_deleted', target, itemId: 'unknown-z', reason: 'never materialized' },
      { mutationType: 'item_deleted', target, itemId: 'unknown-a', reason: 'never materialized' },
      { mutationType: 'item_upsert', target, itemId: 'known', itemOrdinal: 7, createdAt: 3,
        item: { role: 'assistant', content: 'known' }, pending: false, planStageId: null },
      { mutationType: 'item_deleted', target, itemId: 'known', reason: 'later deleted' },
      { mutationType: 'run_state', target, runId: 'run', turnId: null, status: 'done', error: null },
    ])
    const source = join(directory, 'rollout.jsonl')
    await writeFile(source, `${values.map(encodeAgentRolloutRecord).join('\n')}\n`)
    await createRolloutProjector(executor).reconcileHistory(source)
    const repository = createRolloutQueryRepository(executor)

    const hidden = await repository.listItems({ target })
    expect(hidden).toMatchObject({ history: { status: 'done', complete: true, itemCount: 0 }, items: [] })
    const first = await repository.listItems({ target, includeDeleted: true, limit: 1 })
    expect(first.items).toEqual([expect.objectContaining({ itemId: 'unknown-a', materialized: false,
      itemOrdinal: null, role: null, deleted: true })])
    const second = await repository.listItems({ target, includeDeleted: true, limit: 1,
      cursor: first.nextCursor })
    expect(second.items).toEqual([expect.objectContaining({ itemId: 'unknown-z', materialized: false })])
    const third = await repository.listItems({ target, includeDeleted: true, limit: 1,
      cursor: second.nextCursor })
    expect(third.items).toEqual([expect.objectContaining({ itemId: 'known', materialized: true,
      itemOrdinal: 7, role: 'assistant', deleted: true })])
    await expect(repository.readItem({ target, itemId: 'unknown-a' })).rejects
      .toMatchObject({ code: 'AGENT_HISTORY_ITEM_DELETED' })
  })
})
