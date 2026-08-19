import { beforeEach, describe, expect, it } from 'vitest'
import { __resetSqliteLogForTest, configureTraceSqlExecutor } from './sqliteLogTransport'
import { createSqliteLogReader } from './sqliteLogReader'
import { makeFakeExecutor, selectedSql, type FakeSqlExecutor } from './sqliteLog.testHarness'

let fakeDb: FakeSqlExecutor

const SPAN_ROW = {
  id: 'span-1',
  trace_id: 'trace-1',
  session_id: 's-1',
  run_id: 'r-1',
  turn_id: 't-1',
  parent_span_id: null,
  name: 'agent.run',
  kind: 'agent',
  status: 'ok',
  started_at: 10,
  ended_at: 20,
  duration_ms: 10,
  attrs: JSON.stringify({ model: 'x' }),
  error: null,
}

const EVENT_ROW = {
  id: 'evt-1',
  trace_id: 'trace-1',
  session_id: 's-1',
  run_id: null,
  turn_id: null,
  span_id: 'span-1',
  name: 'tool.result',
  timestamp: 15,
  attrs: null,
}

/** 按 SQL 里出现的表名派发行——两条 SELECT 是并发的，不能按调用顺序认。 */
function serveRows(spans: unknown[], events: unknown[]): void {
  fakeDb.select.mockImplementation(async (sql: string) => (
    sql.includes('FROM trace_spans') ? spans : events
  ))
}

beforeEach(() => {
  fakeDb = makeFakeExecutor()
  configureTraceSqlExecutor(async () => fakeDb)
  __resetSqliteLogForTest()
})

describe('createSqliteLogReader', () => {
  it('把两张表的行映射成 TraceLogSnapshot', async () => {
    serveRows([SPAN_ROW], [EVENT_ROW])

    const snapshot = await createSqliteLogReader().readAll()

    expect(snapshot.source).toBe('sqlite')
    expect(snapshot.loadedAt).toEqual(expect.any(Number))
    expect(snapshot.spans).toEqual([
      {
        id: 'span-1',
        traceId: 'trace-1',
        parentSpanId: undefined,
        name: 'agent.run',
        kind: 'agent',
        status: 'ok',
        startedAt: 10,
        endedAt: 20,
        durationMs: 10,
        // 三个索引列被合回 attrs：写入端把它们提出去了，读回来时不补就等于丢了会话归属。
        attrs: { model: 'x', sessionId: 's-1', runId: 'r-1', turnId: 't-1' },
        error: undefined,
      },
    ])
    expect(snapshot.events).toEqual([
      {
        id: 'evt-1',
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'tool.result',
        timestamp: 15,
        attrs: { sessionId: 's-1' },
      },
    ])
  })

  it('attrs 里已有的同名值优先于列', async () => {
    serveRows([{ ...SPAN_ROW, attrs: JSON.stringify({ sessionId: 'from-attrs' }) }], [])

    const [span] = (await createSqliteLogReader().readAll()).spans

    expect(span?.attrs?.sessionId).toBe('from-attrs')
  })

  it('坏 attrs / 未知 kind / 未知 status 各自落到安全值', async () => {
    serveRows([{ ...SPAN_ROW, attrs: '{不是 JSON', kind: 'weird', status: 'weird' }], [])

    const [span] = (await createSqliteLogReader().readAll()).spans

    expect(span?.kind).toBe('internal')
    expect(span?.status).toBe('error')
    expect(span?.attrs).toEqual({ sessionId: 's-1', runId: 'r-1', turnId: 't-1' })
  })

  it('三列全空且 attrs 为空时，attrs 是 undefined 而不是空对象', async () => {
    serveRows([{ ...SPAN_ROW, session_id: null, run_id: null, turn_id: null, attrs: null }], [])

    const [span] = (await createSqliteLogReader().readAll()).spans

    expect(span?.attrs).toBeUndefined()
  })

  // 表还不存在（本进程一条 span 都没写过）时的形态：快照是空的，但结构完整、不抛。
  it('SELECT 失败时收成空快照', async () => {
    fakeDb.select.mockRejectedValue(new Error('no such table: trace_spans'))

    await expect(createSqliteLogReader().readAll()).resolves.toEqual({
      source: 'sqlite',
      loadedAt: expect.any(Number),
      spans: [],
      events: [],
    })
  })

  // 读取端必须是纯读：走建表那条路会顺带把遗留的 running span 收成 cancelled，
  // 于是「打开一次 trace 面板」变成一次写。
  it('只发 SELECT，一条 execute 都不发', async () => {
    serveRows([], [])

    await createSqliteLogReader().readAll()

    expect(fakeDb.execute).not.toHaveBeenCalled()
    expect(selectedSql(fakeDb)).toHaveLength(2)
    expect(selectedSql(fakeDb).every((sql) => sql.trimStart().startsWith('SELECT'))).toBe(true)
  })

  it('两条 SELECT 各自带排序与上限', async () => {
    serveRows([], [])

    await createSqliteLogReader().readAll()

    const [spans, events] = selectedSql(fakeDb)
    expect(spans).toContain('ORDER BY started_at DESC')
    expect(spans).toContain('LIMIT 2000')
    expect(events).toContain('ORDER BY timestamp DESC')
    expect(events).toContain('LIMIT 4000')
  })

  it('没有执行面时以 rejection 失败（而不是静默的空快照）', async () => {
    configureTraceSqlExecutor(undefined)
    __resetSqliteLogForTest()

    await expect(createSqliteLogReader().readAll()).rejects.toThrow(/configureTraceSqlExecutor/)
  })
})
