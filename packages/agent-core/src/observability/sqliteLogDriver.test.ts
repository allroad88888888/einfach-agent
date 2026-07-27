import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeFakeDb() {
  return {
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 0 })),
    select: vi.fn(async (_sql: string, _params?: unknown[]) => []),
  }
}

let fakeDb = makeFakeDb()

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: () => Promise.resolve(fakeDb) },
}))

import { __resetSqliteLogForTest, createSqliteLogDriver } from './sqliteLogDriver'

beforeEach(() => {
  fakeDb = makeFakeDb()
  __resetSqliteLogForTest()
})

describe('sqliteLogDriver', () => {
  it('首次初始化时把上次进程遗留的 running trace 收为 cancelled', async () => {
    const driver = createSqliteLogDriver()

    await driver.writeSpan({
      id: 'span-new',
      traceId: 'trace-new',
      name: 'agent.run',
      kind: 'agent',
      status: 'running',
      startedAt: 10,
    })

    const recovery = fakeDb.execute.mock.calls.find(
      ([sql]) => String(sql).includes('UPDATE trace_spans'),
    )
    const insert = fakeDb.execute.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT OR REPLACE INTO trace_spans'),
    )

    expect(recovery).toBeDefined()
    expect(String(recovery?.[0])).toContain("status = 'cancelled'")
    expect(String(recovery?.[0])).toContain("WHERE status = 'running'")
    expect(recovery?.[1]).toEqual([expect.any(Number)])
    expect(insert).toBeDefined()
    expect(fakeDb.execute.mock.invocationCallOrder[
      fakeDb.execute.mock.calls.indexOf(recovery!)
    ]).toBeLessThan(
      fakeDb.execute.mock.invocationCallOrder[
        fakeDb.execute.mock.calls.indexOf(insert!)
      ],
    )
  })

  it('旧 trace 恢复失败仍继续写当前 span', async () => {
    fakeDb.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE trace_spans')) throw new Error('locked')
      return { rowsAffected: 0 }
    })
    const driver = createSqliteLogDriver()

    await expect(driver.writeSpan({
      id: 'span-new',
      traceId: 'trace-new',
      name: 'agent.run',
      kind: 'agent',
      status: 'running',
      startedAt: 10,
    })).resolves.toBeUndefined()

    expect(fakeDb.execute.mock.calls.some(
      ([sql]) => String(sql).includes('INSERT OR REPLACE INTO trace_spans'),
    )).toBe(true)
  })
})
