import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteExecuteHandler, createSqliteSelectHandler } from './commands'
import { closeSqliteConnections } from './connections'
import type { NodeHostCommandHandler } from '../routeTable'

let root: string
let execute: NodeHostCommandHandler
let select: NodeHostCommandHandler

beforeEach(async () => {
  // 隔离到临时库文件：默认路径指向运行测试那个人的真实会话库。
  root = await mkdtemp(join(tmpdir(), 'web-agent-sqlite-cmd-'))
  const options = { homeDir: root, databasePath: join(root, 'web-agent.db') }
  execute = createSqliteExecuteHandler(options)
  select = createSqliteSelectHandler(options)
})

afterEach(async () => {
  await closeSqliteConnections()
  await rm(root, { recursive: true, force: true })
})

describe('sqlite 命令 handler', () => {
  it('建表、写入、读回：execute 回 rowsAffected，select 回行', async () => {
    await execute({
      connection: 'persistence',
      sql: 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, meta TEXT NOT NULL)',
    })
    const written = await execute({
      connection: 'persistence',
      sql: 'INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)',
      params: ['__all__', '[]'],
    })
    expect(written).toEqual({ rowsAffected: 1 })
    const rows = await select({
      connection: 'persistence',
      sql: 'SELECT id, meta FROM sessions WHERE id = $1',
      params: ['__all__'],
    })
    expect(rows).toEqual([{ id: '__all__', meta: '[]' }])
  })

  it('params 缺席（undefined）与不传是同一件事', async () => {
    // 判存在只能看值：core 侧的入参构造是整份对象字面量返回，可选项没有值时键**存在且为
    // undefined**；走 HTTP 时 JSON.stringify 又会把它丢掉。用 `'params' in args` 判会写出
    // 「本地能跑、上 server 就变」的 bug，所以两种形态必须等价。
    await execute({ connection: 'persistence', sql: 'CREATE TABLE t (v INTEGER)' })
    expect(await select({ connection: 'persistence', sql: 'SELECT COUNT(*) AS c FROM t' })).toEqual([
      { c: 0 },
    ])
    expect(
      await select({ connection: 'persistence', sql: 'SELECT COUNT(*) AS c FROM t', params: undefined }),
    ).toEqual([{ c: 0 }])
  })

  it('两个连接名在同一个库文件上各开一条连接', async () => {
    await execute({ connection: 'persistence', sql: 'CREATE TABLE t (v INTEGER)' })
    await execute({ connection: 'persistence', sql: 'INSERT INTO t (v) VALUES ($1)', params: [1] })
    // 桌面侧 persistence 与 observability 就是同一个 web-agent.db 上的两条独立连接。
    expect(await select({ connection: 'observability', sql: 'SELECT v FROM t' })).toEqual([{ v: 1 }])
  })

  it('connection 不在词表里时受控失败', async () => {
    // 连接名来自外部载荷（HTTP）。开放字符串会让一个拼错的名字静默开出第三条连接，
    // 症状是「写进去了但另一边读不到」。
    await expect(execute({ connection: 'sessions', sql: 'SELECT 1' })).rejects.toThrow(
      /connection 必须是 persistence \/ observability 之一/,
    )
    await expect(execute({ sql: 'SELECT 1' })).rejects.toThrow(/connection 必须是/)
    await expect(execute({ connection: 'toString', sql: 'SELECT 1' })).rejects.toThrow(
      /connection 必须是/,
    )
  })

  it('sql 与 params 形状不对时受控失败', async () => {
    await expect(select({ connection: 'persistence' })).rejects.toThrow(/sql 必须是非空字符串/)
    await expect(select({ connection: 'persistence', sql: '   ' })).rejects.toThrow(
      /sql 必须是非空字符串/,
    )
    await expect(
      select({ connection: 'persistence', sql: 'SELECT $1', params: 'a' }),
    ).rejects.toThrow(/params 必须是数组/)
  })

  it('失败一律是 rejection，不是同步抛出', () => {
    // 路由表的契约：调用点里有 `void invoke(...).catch(...)` 这种不在 async 函数里的写法，
    // 同步异常会绕过它的 catch 链变成未捕获错误。
    let settled: unknown
    const pending = execute({ connection: 'nope' }).catch((error: unknown) => {
      settled = error
    })
    expect(settled).toBeUndefined()
    return pending.then(() => {
      expect(settled).toBeInstanceOf(Error)
    })
  })

  it('事务控制与多语句在两条命令上都被挡下', async () => {
    await expect(execute({ connection: 'persistence', sql: 'BEGIN' })).rejects.toThrow(
      /不接受事务控制语句/,
    )
    await expect(
      execute({ connection: 'persistence', sql: 'CREATE TABLE a (v INT); CREATE TABLE b (v INT)' }),
    ).rejects.toThrow(/只能执行一条 SQL 语句/)
  })
})
