import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecoverySnapshotV1, SqlExecutor } from '@web-agent/core/state/persistence'

interface RecoveryRow {
  session_id: string
  generation: number
  deleted: number
  snapshot: string | null
}

function createFakeDatabase() {
  const recoveryRows: RecoveryRow[] = []
  return {
    recoveryRows,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE')) return { rowsAffected: 0 }
      if (sql.includes('INSERT INTO recovery_snapshots') && sql.includes('WHERE excluded.generation')) {
        const [sessionId, generation, snapshot] = params as [string, number, string]
        const index = recoveryRows.findIndex((row) => row.session_id === sessionId)
        if (index < 0) {
          recoveryRows.push({ session_id: sessionId, generation, deleted: 0, snapshot })
          return { rowsAffected: 1 }
        }
        const current = recoveryRows[index]
        if (current.deleted === 0 && generation > current.generation) {
          recoveryRows[index] = { session_id: sessionId, generation, deleted: 0, snapshot }
          return { rowsAffected: 1 }
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('INSERT INTO recovery_snapshots') && sql.includes('VALUES ($1, 0, 1, NULL)')) {
        const [sessionId] = params as [string]
        const current = recoveryRows.find((row) => row.session_id === sessionId)
        if (current) {
          current.deleted = 1
          current.snapshot = null
        } else {
          recoveryRows.push({ session_id: sessionId, generation: 0, deleted: 1, snapshot: null })
        }
        return { rowsAffected: 1 }
      }
      return { rowsAffected: 0 }
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('PRAGMA')) return [{ ok: 1 }]
      if (sql.includes('FROM recovery_snapshots WHERE session_id = $1')) {
        const [sessionId] = params as [string]
        return recoveryRows.filter((row) => row.session_id === sessionId)
      }
      if (sql.includes('FROM recovery_snapshots')) {
        return recoveryRows
      }
      return []
    }),
  }
}

function snapshot(generation: number, sessionId = 's1'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId,
    capturedAt: generation,
    generation,
    commitMarker: 'complete',
    session: {
      id: sessionId,
      title: 'Recovery test',
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

let fakeDatabase = createFakeDatabase()
let loadImplementation: () => Promise<unknown> = async () => fakeDatabase

import { __resetSqliteForTest } from './sqliteDriver'
import { createSqliteRecoveryDriver } from './sqliteRecoveryDriver'
import { configureSqlExecutor } from './sqliteShared'

// P1：fake DB 从 configureSqlExecutor 注入槽进来（本包不再 import 具体 SQL 上游包），
// fake 与断言本身未动 —— 它的 execute/select 形状就是 `SqlExecutor` 契约。
beforeEach(() => {
  fakeDatabase = createFakeDatabase()
  loadImplementation = async () => fakeDatabase
  configureSqlExecutor(async () => (await loadImplementation()) as SqlExecutor)
  __resetSqliteForTest()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('createSqliteRecoveryDriver', () => {
  it('有效快照经新 facade 仍可往返读取', async () => {
    const first = createSqliteRecoveryDriver()
    const saved = snapshot(2)
    await expect(first.saveLatest('s1', saved)).resolves.toEqual({ status: 'saved', generation: 2 })

    const second = createSqliteRecoveryDriver()
    expect(await second.loadLatest('s1')).toEqual(saved)
    expect(await second.listLatest()).toEqual([saved])
  })

  it('拒绝 sessionId 不匹配与存储中损坏的 payload', async () => {
    const driver = createSqliteRecoveryDriver()
    const withFunction = snapshot(1, 'function') as RecoverySnapshotV1 & { extension?: unknown }
    withFunction.extension = () => undefined
    await expect(driver.saveLatest('s2', snapshot(1, 's1'))).rejects.toThrow('sessionId')
    await expect(driver.saveLatest('function', withFunction)).rejects.toThrow('validation')
    expect(fakeDatabase.recoveryRows).toEqual([])
    fakeDatabase.recoveryRows.push({
      session_id: 's1', generation: 1, deleted: 0, snapshot: JSON.stringify({ schemaVersion: 1 }),
    })
    await expect(driver.loadLatest('s1')).rejects.toThrow('validation')
  })

  it('条件 UPSERT 仅接受更高 generation，且不发多语句事务控制', async () => {
    const driver = createSqliteRecoveryDriver()
    await driver.saveLatest('s1', snapshot(4))

    await expect(driver.saveLatest('s1', snapshot(4))).resolves.toEqual({
      status: 'stale', currentGeneration: 4,
    })
    await expect(driver.saveLatest('s1', snapshot(5))).resolves.toEqual({ status: 'saved', generation: 5 })
    const statements = fakeDatabase.execute.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => /\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false)
    expect(statements.filter((sql) => sql.includes('WHERE excluded.generation')).length).toBe(3)
  })

  it('tombstone 对 list/load 隐身，且较旧或较新的迟到写均不能复活它', async () => {
    const driver = createSqliteRecoveryDriver()
    await driver.saveLatest('s1', snapshot(2))
    await driver.deleteSession('s1')

    expect(await driver.loadLatest('s1')).toBeUndefined()
    expect(await driver.listLatest()).toEqual([])
    await expect(driver.saveLatest('s1', snapshot(1))).resolves.toEqual({ status: 'tombstoned' })
    await expect(driver.saveLatest('s1', snapshot(99))).resolves.toEqual({ status: 'tombstoned' })
  })
})
