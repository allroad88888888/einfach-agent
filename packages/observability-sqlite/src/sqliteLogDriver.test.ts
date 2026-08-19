import { beforeEach, describe, expect, it } from 'vitest'
import { __resetSqliteLogForTest, configureTraceSqlExecutor } from './sqliteLogTransport'
import { createSqliteLogDriver } from './sqliteLogDriver'
import { executedSql, indexOfExecuted, makeFakeExecutor, type FakeSqlExecutor } from './sqliteLog.testHarness'
import type { TraceEvent, TraceSpan } from '@einfach-agent/core/observability'

let fakeDb: FakeSqlExecutor

const RUNNING_SPAN: TraceSpan = {
  id: 'span-new',
  traceId: 'trace-new',
  name: 'agent.run',
  kind: 'agent',
  status: 'running',
  startedAt: 10,
}

function insertedRow(prefix: string): unknown[] {
  const call = fakeDb.execute.mock.calls.find(([sql]) => String(sql).includes(prefix))
  expect(call, `没有找到 ${prefix}`).toBeDefined()
  return (call as [string, unknown[]])[1]
}

beforeEach(() => {
  fakeDb = makeFakeExecutor()
  configureTraceSqlExecutor(async () => fakeDb)
  __resetSqliteLogForTest()
})

describe('sqliteLogDriver', () => {
  it('首次初始化时把上次进程遗留的 running trace 收为 cancelled', async () => {
    await createSqliteLogDriver().writeSpan(RUNNING_SPAN)

    const recovery = indexOfExecuted(fakeDb, 'UPDATE trace_spans')
    const insert = indexOfExecuted(fakeDb, 'INSERT OR REPLACE INTO trace_spans')

    expect(recovery).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThanOrEqual(0)
    expect(recovery).toBeLessThan(insert)
  })

  it('旧 trace 恢复失败仍继续写当前 span', async () => {
    fakeDb.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE trace_spans')) throw new Error('locked')
      return { rowsAffected: 0 }
    })

    await expect(createSqliteLogDriver().writeSpan(RUNNING_SPAN)).resolves.toBeUndefined()

    expect(executedSql(fakeDb).some((sql) => sql.includes('INSERT OR REPLACE INTO trace_spans'))).toBe(true)
  })

  // 三列是索引列（按 session / run 查 trace 全靠它们）。整条 attrs 仍原样进 attrs 列——
  // 提列丢了的话 TraceViewer 按会话筛选会一条也筛不出来，而快照看起来是满的。
  it('writeSpan 把 sessionId / runId / turnId 提到独立列，并保留整份 attrs', async () => {
    const span: TraceSpan = {
      id: 'span-1',
      traceId: 'trace-1',
      parentSpanId: 'span-0',
      name: 'llm.request',
      kind: 'llm',
      status: 'ok',
      startedAt: 5,
      endedAt: 9,
      durationMs: 4,
      attrs: { sessionId: 's-1', runId: 'r-1', turnId: 't-1', model: 'x' },
      error: 'boom',
    }

    await createSqliteLogDriver().writeSpan(span)

    expect(insertedRow('INSERT OR REPLACE INTO trace_spans')).toEqual([
      'span-1',
      'trace-1',
      's-1',
      'r-1',
      't-1',
      'span-0',
      'llm.request',
      'llm',
      'ok',
      5,
      9,
      4,
      JSON.stringify(span.attrs),
      'boom',
    ])
  })

  it('缺省字段落成 NULL 而不是 undefined', async () => {
    await createSqliteLogDriver().writeSpan(RUNNING_SPAN)

    expect(insertedRow('INSERT OR REPLACE INTO trace_spans')).toEqual([
      'span-new',
      'trace-new',
      null,
      null,
      null,
      null,
      'agent.run',
      'agent',
      'running',
      10,
      null,
      null,
      null,
      null,
    ])
  })

  // 非字符串的 sessionId 塞进索引列会让「按会话查」命中一堆 String(value)；attrs 里那份仍在。
  it('非字符串的 sessionId 不进索引列', async () => {
    const span: TraceSpan = { ...RUNNING_SPAN, attrs: { sessionId: 42 } }

    await createSqliteLogDriver().writeSpan(span)

    expect(insertedRow('INSERT OR REPLACE INTO trace_spans')[2]).toBeNull()
  })

  it('writeEvent 按九列写入', async () => {
    const event: TraceEvent = {
      id: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'tool.result',
      timestamp: 77,
      attrs: { sessionId: 's-1', runId: 'r-1', turnId: 't-1' },
    }

    await createSqliteLogDriver().writeEvent(event)

    expect(insertedRow('INSERT OR REPLACE INTO trace_events')).toEqual([
      'evt-1',
      'trace-1',
      's-1',
      'r-1',
      't-1',
      'span-1',
      'tool.result',
      77,
      JSON.stringify(event.attrs),
    ])
  })

  // best-effort 的边界：装配层没注入执行面时，trace 失败不能把主流程带下水。
  it('没有执行面时两个写入都静默成功', async () => {
    configureTraceSqlExecutor(undefined)
    __resetSqliteLogForTest()
    const driver = createSqliteLogDriver()

    await expect(driver.writeSpan(RUNNING_SPAN)).resolves.toBeUndefined()
    await expect(
      driver.writeEvent({ id: 'evt', traceId: 'trace', name: 'x', timestamp: 1 }),
    ).resolves.toBeUndefined()
  })
})
