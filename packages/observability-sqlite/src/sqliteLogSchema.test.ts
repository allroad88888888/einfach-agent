import { describe, expect, it } from 'vitest'
import { bringUpTraceSchema } from './sqliteLogSchema'
import { executedSql, indexOfExecuted, makeFakeExecutor, selectedSql } from './sqliteLog.testHarness'

describe('bringUpTraceSchema', () => {
  // P2 实测过的坑：node:sqlite 的 `prepare("A; B").run()` 回 `{changes:1}` 却只执行第一条。
  // Node 宿主因此在执行前就把多语句判成非法输入，桌面侧却照跑——把 DDL 拼起来省往返的后果是
  // 「桌面能跑、换 server 宿主整段建表失败」。这条判据把它钉死在包内。
  it('每次调用都只带一条自包含语句（没有分号拼接）', async () => {
    const db = makeFakeExecutor()
    await bringUpTraceSchema(db)

    for (const sql of [...executedSql(db), ...selectedSql(db)]) {
      expect(sql, `不该含分号：${sql}`).not.toContain(';')
    }
  })

  // PRAGMA 会回一行当前值。走 execute 会被下游执行面判成「非法语句」，整段调优静默失效。
  it('三条 PRAGMA 走 select，且一条都不走 execute', async () => {
    const db = makeFakeExecutor()
    await bringUpTraceSchema(db)

    expect(selectedSql(db)).toEqual([
      'PRAGMA journal_mode=WAL',
      'PRAGMA busy_timeout=5000',
      'PRAGMA synchronous=NORMAL',
    ])
    expect(executedSql(db).some((sql) => sql.includes('PRAGMA'))).toBe(false)
  })

  it('PRAGMA 全部失败也照样建表', async () => {
    const db = makeFakeExecutor()
    db.select.mockRejectedValue(new Error('unsupported'))

    await expect(bringUpTraceSchema(db)).resolves.toBeUndefined()
    expect(executedSql(db).some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS trace_spans'))).toBe(true)
  })

  // 顺序即语义：新库靠建表就带齐三列，旧库靠 ALTER 补；索引用到 session_id，必须排在补列之后。
  it('建表 → 补列 → 建索引 → 收遗留 running，顺序固定', async () => {
    const db = makeFakeExecutor()
    await bringUpTraceSchema(db)

    const createSpans = indexOfExecuted(db, 'CREATE TABLE IF NOT EXISTS trace_spans')
    const createEvents = indexOfExecuted(db, 'CREATE TABLE IF NOT EXISTS trace_events')
    const addColumn = indexOfExecuted(db, 'ALTER TABLE trace_spans ADD COLUMN session_id')
    const createIndex = indexOfExecuted(db, 'idx_trace_spans_session_started')
    const recover = indexOfExecuted(db, 'UPDATE trace_spans')

    expect(createSpans).toBeGreaterThanOrEqual(0)
    expect(createSpans).toBeLessThan(createEvents)
    expect(createEvents).toBeLessThan(addColumn)
    expect(addColumn).toBeLessThan(createIndex)
    expect(createIndex).toBeLessThan(recover)
  })

  it('六条补列语句与六条索引语句一条不少', async () => {
    const db = makeFakeExecutor()
    await bringUpTraceSchema(db)
    const sql = executedSql(db)

    expect(sql.filter((item) => item.startsWith('ALTER TABLE'))).toHaveLength(6)
    expect(sql.filter((item) => item.includes('CREATE INDEX'))).toHaveLength(6)
  })

  // 列已存在时 SQLite 直接报错，那正是「不需要迁移」的正常情形。吞不掉的话，任何一个已经迁移过
  // 的旧库都会在启动时整段建表失败，trace 从此不落盘。
  it('补列失败（列已存在）不阻塞后续索引与恢复', async () => {
    const db = makeFakeExecutor()
    db.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('ALTER TABLE')) throw new Error('duplicate column name')
      return { rowsAffected: 0 }
    })

    await expect(bringUpTraceSchema(db)).resolves.toBeUndefined()
    expect(indexOfExecuted(db, 'idx_trace_events_run_id')).toBeGreaterThanOrEqual(0)
    expect(indexOfExecuted(db, 'UPDATE trace_spans')).toBeGreaterThanOrEqual(0)
  })

  it('收遗留 running：只改 running 行，$1 出现两次而只传一个参数', async () => {
    const db = makeFakeExecutor()
    await bringUpTraceSchema(db)

    const recover = db.execute.mock.calls.find(([sql]) => String(sql).includes('UPDATE trace_spans'))
    expect(recover).toBeDefined()
    const [sql, params] = recover as [string, unknown[]]
    expect(sql).toContain("status = 'cancelled'")
    expect(sql).toContain("WHERE status = 'running'")
    expect(sql).toContain("COALESCE(error, 'Recovered after application restart')")
    // 位置绑定做不到这件事；两条执行面都按名字绑，所以同一个 `$1` 出现两次仍只需一个值。
    expect(sql.match(/\$1\b/g)).toHaveLength(2)
    expect(params).toEqual([expect.any(Number)])
  })

  it('收遗留 running 失败不抛：新会话仍能跑', async () => {
    const db = makeFakeExecutor()
    db.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE trace_spans')) throw new Error('locked')
      return { rowsAffected: 0 }
    })

    await expect(bringUpTraceSchema(db)).resolves.toBeUndefined()
  })
})
