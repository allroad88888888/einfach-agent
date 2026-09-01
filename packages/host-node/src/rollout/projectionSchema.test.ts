import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import {
  AGENT_ROLLOUT_PROJECTION_TABLES,
  dropRolloutProjectionSchema,
  ensureRolloutProjectionSchema,
} from './projectionSchema'

let database: DatabaseSync | undefined

afterEach(() => {
  database?.close()
  database = undefined
})

describe('rollout projection schema', () => {
  it('creates all projection tables idempotently and can delete only the projection', async () => {
    database = new DatabaseSync(':memory:')
    const executor = createSqliteExecutor(database, 'projection-schema-test')
    await executor.execute('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')

    await ensureRolloutProjectionSchema(executor)
    await ensureRolloutProjectionSchema(executor)
    const created = await executor.select<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    expect(created.map(({ name }) => name)).toEqual([
      ...AGENT_ROLLOUT_PROJECTION_TABLES,
      'unrelated',
    ].sort())

    await dropRolloutProjectionSchema(executor)
    const remaining = await executor.select<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    expect(remaining).toEqual([{ name: 'unrelated' }])
  })
})
