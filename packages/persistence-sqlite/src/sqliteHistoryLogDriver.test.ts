import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedHistoryLog, SqlExecutor } from '@web-agent/core/state/persistence'

interface HistoryLogRow {
  session_id: string
  generation: number
  payload: string
}

function createFakeDatabase() {
  const rows: HistoryLogRow[] = []
  return {
    rows,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE') || sql.includes('DROP TABLE')) return { rowsAffected: 0 }
      if (sql.includes('INSERT INTO history_log')) {
        const [sessionId, generation, payload] = params as [string, number, string]
        const index = rows.findIndex((row) => row.session_id === sessionId)
        const row = { session_id: sessionId, generation, payload }
        if (index < 0) rows.push(row)
        else rows[index] = row
        return { rowsAffected: 1 }
      }
      if (sql.includes('DELETE FROM history_log')) {
        const [sessionId] = params as [string]
        const index = rows.findIndex((row) => row.session_id === sessionId)
        if (index >= 0) rows.splice(index, 1)
        return { rowsAffected: index >= 0 ? 1 : 0 }
      }
      return { rowsAffected: 0 }
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('PRAGMA')) return [{ ok: 1 }]
      if (sql.includes('FROM history_log WHERE session_id = $1')) {
        const [sessionId] = params as [string]
        return rows.filter((row) => row.session_id === sessionId)
      }
      return []
    }),
  }
}

let database = createFakeDatabase()
let loadImplementation: () => Promise<unknown> = async () => database

import { __resetSqliteForTest } from './sqliteDriver'
import { createSqliteHistoryLogDriver } from './sqliteHistoryLogDriver'
import { configureSqlExecutor } from './sqliteShared'

function log(generation: number, entryCount = 1): PersistedHistoryLog {
  return {
    generation,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      txId: `tx-${index + 1}`,
      label: 't1',
      ops: [{ key: 'fixtureSlot', before: '', after: `值${index}` }],
    })),
    cursor: entryCount,
  }
}

// P1：fake DB 从 configureSqlExecutor 注入槽进来（本包不再 import 具体 SQL 上游包），
// fake 与断言本身未动 —— 它的 execute/select 形状就是 `SqlExecutor` 契约。
beforeEach(() => {
  database = createFakeDatabase()
  loadImplementation = async () => database
  configureSqlExecutor(async () => (await loadImplementation()) as SqlExecutor)
  __resetSqliteForTest()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('SQLite 事务日志 driver', () => {
  it('往返保住条目与游标', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(7, 3))

    const loaded = await driver.load('s1')
    expect(loaded?.generation).toBe(7)
    expect(loaded?.cursor).toBe(3)
    expect(loaded?.entries).toHaveLength(3)
  })

  it('同一 session 整份覆盖，不追加', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(1, 5))
    await driver.save('s1', log(2, 2))

    expect(database.rows).toHaveLength(1)
    expect((await driver.load('s1'))?.entries).toHaveLength(2)
  })

  it('generation 以列为准，不信 payload 里那份副本', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(3))
    // 手工制造两者不一致：配对判据必须取列。
    database.rows[0]!.payload = JSON.stringify({ ...log(999), generation: 999 })

    expect((await driver.load('s1'))?.generation).toBe(3)
  })

  it('没有记录时返回 undefined', async () => {
    expect(await createSqliteHistoryLogDriver().load('missing')).toBeUndefined()
  })

  it('删除后读不到', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(1))
    await driver.deleteSession('s1')

    expect(await driver.load('s1')).toBeUndefined()
  })

  it('payload 是坏 JSON 时降级为「没有日志」而不是抛', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(1))
    database.rows[0]!.payload = '{ 这不是 JSON'

    expect(await driver.load('s1')).toBeUndefined()
  })

  it('payload 缺 entries 时降级为「没有日志」', async () => {
    const driver = createSqliteHistoryLogDriver()
    await driver.save('s1', log(1))
    database.rows[0]!.payload = JSON.stringify({ generation: 1, cursor: 0 })

    expect(await driver.load('s1')).toBeUndefined()
  })

  it('空 sessionId 拒绝', async () => {
    await expect(createSqliteHistoryLogDriver().load('')).rejects.toThrow(/sessionId/)
  })
})
