import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSqliteLogForTest,
  configureTraceSqlExecutor,
  getTraceDb,
  loadTraceSqlExecutor,
} from './sqliteLogTransport'
import { executedSql, makeFakeExecutor } from './sqliteLog.testHarness'

beforeEach(() => {
  configureTraceSqlExecutor(undefined)
  __resetSqliteLogForTest()
})

describe('未注入执行面', () => {
  it('两个取用面都以 rejection 失败，并点名 configureTraceSqlExecutor', async () => {
    await expect(loadTraceSqlExecutor()).rejects.toThrow(/configureTraceSqlExecutor/)
    await expect(getTraceDb()).rejects.toThrow(/configureTraceSqlExecutor/)
  })

  it('失败不进缓存：补上注入后立刻可用', async () => {
    await expect(getTraceDb()).rejects.toThrow()
    const db = makeFakeExecutor()
    configureTraceSqlExecutor(async () => db)
    await expect(getTraceDb()).resolves.toBe(db)
  })
})

describe('惰性与 memo', () => {
  it('loader 只被解析一次，两个取用面共用同一个执行面', async () => {
    const db = makeFakeExecutor()
    const loader = vi.fn(async () => db)
    configureTraceSqlExecutor(loader)

    await Promise.all([getTraceDb(), getTraceDb(), loadTraceSqlExecutor()])

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('表只建一次：多次 getTraceDb 不重复发 DDL', async () => {
    const db = makeFakeExecutor()
    configureTraceSqlExecutor(async () => db)

    await getTraceDb()
    const afterFirst = executedSql(db).length
    await getTraceDb()

    expect(afterFirst).toBeGreaterThan(0)
    expect(executedSql(db)).toHaveLength(afterFirst)
  })

  // 读取端（TraceViewer）走的就是这条路。它若顺带建表，打开一次 trace 面板就会把正在运行的
  // span 收成 cancelled——那是只读动作里藏了一次写。
  it('loadTraceSqlExecutor 不建表、不发任何语句', async () => {
    const db = makeFakeExecutor()
    configureTraceSqlExecutor(async () => db)

    await loadTraceSqlExecutor()

    expect(db.execute).not.toHaveBeenCalled()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('建表失败时清掉 memo，下次重试', async () => {
    const db = makeFakeExecutor()
    db.execute.mockRejectedValueOnce(new Error('locked'))
    configureTraceSqlExecutor(async () => db)

    await expect(getTraceDb()).rejects.toThrow('locked')
    await expect(getTraceDb()).resolves.toBe(db)
  })

  it('loader 失败不进缓存，下次重试', async () => {
    const db = makeFakeExecutor()
    const loader = vi
      .fn<() => Promise<typeof db>>()
      .mockRejectedValueOnce(new Error('no runtime'))
      .mockResolvedValue(db)
    configureTraceSqlExecutor(loader)

    await expect(loadTraceSqlExecutor()).rejects.toThrow('no runtime')
    await expect(loadTraceSqlExecutor()).resolves.toBe(db)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('重新注入', () => {
  // 不作废缓存的话，换宿主（或测试之间换替身）会继续用上一个 loader 解析出来的那条连接：
  // configure 看起来成功了、实际没生效。
  it('作废执行面缓存：后续取用拿到的是新执行面', async () => {
    const first = makeFakeExecutor()
    const second = makeFakeExecutor()
    configureTraceSqlExecutor(async () => first)
    await getTraceDb()

    configureTraceSqlExecutor(async () => second)

    await expect(getTraceDb()).resolves.toBe(second)
  })

  // 只清执行面、不清建表 memo 的话，新连接上一张表都没有；而 SELECT 失败在读取端是静默的空集。
  it('作废建表缓存：新执行面上重新建表', async () => {
    const first = makeFakeExecutor()
    const second = makeFakeExecutor()
    configureTraceSqlExecutor(async () => first)
    await getTraceDb()

    configureTraceSqlExecutor(async () => second)
    await getTraceDb()

    expect(executedSql(second).some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS trace_spans'))).toBe(true)
  })
})
