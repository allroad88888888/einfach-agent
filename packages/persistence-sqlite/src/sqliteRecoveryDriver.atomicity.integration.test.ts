// SQLite 恢复快照的原子写入黑盒契约。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecoverySnapshotV1 } from '@web-agent/core/state/persistence'

interface RecoveryRow {
  session_id: string
  generation: number
  deleted: number
  snapshot: string | null
}

function createAtomicSqlite() {
  const rows: RecoveryRow[] = []
  const statements: string[] = []

  return {
    rows,
    statements,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql)
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE')) return { rowsAffected: 0 }
      if (sql.includes('WHERE excluded.generation')) {
        const [sessionId, generation, snapshot] = params as [string, number, string]
        const index = rows.findIndex((row) => row.session_id === sessionId)
        if (index < 0) {
          rows.push({ session_id: sessionId, generation, deleted: 0, snapshot })
          return { rowsAffected: 1 }
        }
        const current = rows[index]
        if (current.deleted === 0 && generation > current.generation) {
          rows[index] = { session_id: sessionId, generation, deleted: 0, snapshot }
          return { rowsAffected: 1 }
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('VALUES ($1, 0, 1, NULL)')) {
        const [sessionId] = params as [string]
        const current = rows.find((row) => row.session_id === sessionId)
        if (current) {
          current.deleted = 1
          current.snapshot = null
        } else {
          rows.push({ session_id: sessionId, generation: 0, deleted: 1, snapshot: null })
        }
        return { rowsAffected: 1 }
      }
      if (sql.startsWith('DROP TABLE')) return { rowsAffected: 0 }
      throw new Error(`Unexpected SQLite statement: ${sql}`)
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql)
      if (sql.startsWith('PRAGMA')) return [{ ok: 1 }]
      if (sql.includes('WHERE session_id = $1')) {
        const [sessionId] = params as [string]
        return rows.filter((row) => row.session_id === sessionId)
      }
      if (sql.includes('FROM recovery_snapshots')) return rows
      return []
    }),
  }
}

function snapshot(generation: number, sessionId = 'atomic-session'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId,
    capturedAt: generation,
    generation,
    commitMarker: 'complete',
    session: {
      id: sessionId,
      title: 'Atomicity test',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 0,
      updatedAt: 0,
    },
    values: {
      conversation: { items: [], contextCheckpoint: null },
      plan: { current: null, stageCheckpoints: [] },
      run: null,
      queuedUserMessages: [],
      pendingQuestionAnswers: {},
      pendingArtifacts: [],
      executionGraph: { version: 1, nodes: {}, order: [] },
      subagentContinuations: [],
    },
  }
}

let sqlite = createAtomicSqlite()
let loadDatabase: () => Promise<unknown> = async () => sqlite

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: () => loadDatabase() },
}))

import { __resetSqliteForTest } from './sqliteDriver'
import { createSqliteRecoveryDriver } from './sqliteRecoveryDriver'

beforeEach(() => {
  sqlite = createAtomicSqlite()
  loadDatabase = async () => sqlite
  __resetSqliteForTest()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('SQLite recovery snapshot atomicity', () => {
  it('publishes only the higher generation and a new facade observes that committed value', async () => {
    const writer = createSqliteRecoveryDriver()
    await expect(writer.saveLatest('atomic-session', snapshot(5))).resolves.toEqual({
      status: 'saved', generation: 5,
    })
    await expect(writer.saveLatest('atomic-session', snapshot(4))).resolves.toEqual({
      status: 'stale', currentGeneration: 5,
    })

    const reader = createSqliteRecoveryDriver()
    await expect(reader.loadLatest('atomic-session')).resolves.toEqual(snapshot(5))
    expect(sqlite.rows).toMatchObject([{ session_id: 'atomic-session', generation: 5, deleted: 0 }])
  })

  it('uses a terminal tombstone fence so any late save remains invisible', async () => {
    const writer = createSqliteRecoveryDriver()
    await writer.saveLatest('atomic-session', snapshot(7))
    await writer.deleteSession('atomic-session')

    await expect(writer.saveLatest('atomic-session', snapshot(99))).resolves.toEqual({
      status: 'tombstoned',
    })
    const reader = createSqliteRecoveryDriver()
    await expect(reader.loadLatest('atomic-session')).resolves.toBeUndefined()
    await expect(reader.listLatest()).resolves.toEqual([])
    expect(sqlite.rows).toEqual([{
      session_id: 'atomic-session', generation: 7, deleted: 1, snapshot: null,
    }])
  })

  it('fails closed for malformed payloads and unknown snapshot versions', async () => {
    const driver = createSqliteRecoveryDriver()
    sqlite.rows.push({
      session_id: 'atomic-session', generation: 2, deleted: 0, snapshot: '{not-json',
    })
    await expect(driver.loadLatest('atomic-session')).rejects.toThrow('Corrupt SQLite recovery JSON')

    sqlite.rows[0].snapshot = JSON.stringify({ ...snapshot(2), schemaVersion: 2 })
    await expect(driver.loadLatest('atomic-session')).rejects.toThrow('validation')
  })

  it('never issues transaction-control SQL for recovery writes', async () => {
    const driver = createSqliteRecoveryDriver()
    await driver.saveLatest('atomic-session', snapshot(1))
    await driver.saveLatest('atomic-session', snapshot(2))
    await driver.deleteSession('atomic-session')

    expect(sqlite.statements.filter((statement) => /\b(BEGIN|COMMIT|ROLLBACK)\b/i.test(statement))).toEqual([])
    expect(sqlite.statements.filter((statement) => statement.includes('WHERE excluded.generation'))).toHaveLength(2)
  })
})
