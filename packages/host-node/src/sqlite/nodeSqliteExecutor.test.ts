import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteExecutor } from './nodeSqliteExecutor'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

// 用 `:memory:` 而不是临时文件：本文件只验「一条语句怎么被执行」，落盘与连接复用是
// connections.ts 的事。内存库同样是真的 SQLite，没有 mock 掉任何被测行为。
let database: DatabaseSync
let executor: SqlExecutor

beforeEach(() => {
  database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, meta TEXT NOT NULL)')
  executor = createSqliteExecutor(database, 'test@:memory:')
})

afterEach(() => {
  database.close()
})

describe('createSqliteExecutor', () => {
  it('execute 回 rowsAffected，select 回行', async () => {
    const inserted = await executor.execute(
      'INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)',
      ['__all__', '[]'],
    )
    expect(inserted).toEqual({ rowsAffected: 1 })

    const rows = await executor.select<{ id: string; meta: string }[]>(
      'SELECT id, meta FROM sessions WHERE id = $1',
      ['__all__'],
    )
    expect(rows).toEqual([{ id: '__all__', meta: '[]' }])
  })

  it('rowsAffected 是真的命中行数（条件 UPSERT 的三态就靠它区分）', async () => {
    await executor.execute('INSERT INTO sessions (id, meta) VALUES ($1, $2)', ['a', '1'])
    const missed = await executor.execute('UPDATE sessions SET meta = $1 WHERE id = $2', ['2', 'b'])
    expect(missed).toEqual({ rowsAffected: 0 })
    const hit = await executor.execute('UPDATE sessions SET meta = $1 WHERE id = $2', ['2', 'a'])
    expect(hit).toEqual({ rowsAffected: 1 })
  })

  it('位置数组按 $1、$2 的编号绑定，且同一个 $1 复用一个值', async () => {
    // node:sqlite 的**匿名**绑定会跳过带名字的参数，而 `$1` 在 SQLite 眼里是有名字的，
    // 位置绑定会当场 SQLITE_RANGE。这条用例钉住「走的是具名绑定」。
    const rows = await executor.select<{ one: string; again: string; two: number }[]>(
      'SELECT $1 AS one, $1 AS again, $2 AS two',
      ['x', 7],
    )
    expect(rows).toEqual([{ one: 'x', again: 'x', two: 7 }])
  })

  it('参数个数与占位符对不上时受控失败（少传尤其要挡）', async () => {
    // 少传不拦的话 `$1` 会被静默绑成 NULL，一次查询安静地返回空集——看起来像「数据没了」。
    await expect(executor.select('SELECT * FROM sessions WHERE id = $1')).rejects.toThrow(
      /需要 1 个参数，实际传入 0 个/,
    )
    await expect(
      executor.select('SELECT * FROM sessions WHERE id = $1', ['a', 'b']),
    ).rejects.toThrow(/需要 1 个参数，实际传入 2 个/)
  })

  it('PRAGMA 走 select：有返回行的回值，没有的回空数组', async () => {
    expect(await executor.select('PRAGMA journal_mode=MEMORY')).toEqual([{ journal_mode: 'memory' }])
    expect(await executor.select('PRAGMA busy_timeout=5000')).toEqual([{ timeout: 5000 }])
    expect(await executor.select('PRAGMA synchronous=NORMAL')).toEqual([])
  })

  it('null / undefined / 布尔按桌面宿主那条路的语义绑定', async () => {
    // 桌面侧入参要过 Tauri IPC 的 JSON 序列化：undefined 到不了 Rust，落地就是 null；
    // sqlx 把 bool 绑成 0/1。这里原样抛错的话，同一份调用代码会「进程内注入时报错、走 HTTP 时正常」。
    const rows = await executor.select<{ a: unknown; b: unknown; c: unknown; d: unknown }[]>(
      'SELECT $1 AS a, $2 AS b, $3 AS c, $4 AS d',
      [null, undefined, true, false],
    )
    expect(rows).toEqual([{ a: null, b: null, c: 1, d: 0 }])
  })

  it('绑不了的值受控失败，不猜一种编码', async () => {
    await expect(executor.execute('SELECT $1', [{ nested: 1 }])).rejects.toThrow(/无法绑定/)
    await expect(executor.execute('SELECT $1', [Number.NaN])).rejects.toThrow(/无法存储/)
  })

  it('行是普通对象，不是 null 原型对象', async () => {
    // 走 HTTP 时行会被 JSON 序列化再解析，那一头拿到的必然是普通对象。进程内注入若原样返回
    // node:sqlite 的 null 原型对象，「本地能跑、上 server 就变」的差异又多一处。
    const [row] = await executor.select<Record<string, unknown>[]>('SELECT 1 AS v')
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
  })

  it('SQL 出错时带上是哪条连接，并把原错误挂在 cause 上', async () => {
    const error = await executor.execute('SELECT * FROM nope').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('test@:memory:')
    // `errcode` / `errstr` 是排查「是不是被锁住了」的唯一线索，不能在包装时丢掉。
    expect((error as Error).cause).toBeDefined()
  })

  it('公开面只有 execute / select——没有事务、没有批量、不漏底层句柄', () => {
    // port 只承诺「收一条自包含语句、把它执行掉」；多一个 transaction() 就等于向所有调用方
    // 宣告「这几条会落在同一条连接上」，而那正是这套设计刻意不再依赖的假设。
    expect(Object.keys(executor).sort()).toEqual(['execute', 'select'])
  })

  it('事务控制语句与多语句在执行前就被挡下', async () => {
    await expect(executor.execute('BEGIN')).rejects.toThrow(/不接受事务控制语句/)
    await expect(
      executor.execute("INSERT INTO sessions (id, meta) VALUES ('x','1'); DELETE FROM sessions"),
    ).rejects.toThrow(/只能执行一条 SQL 语句/)
    // 真的没执行：BEGIN 若溜过去，后面那条 DELETE 会在一个开着的事务里跑。
    expect(await executor.select('SELECT COUNT(*) AS c FROM sessions')).toEqual([{ c: 0 }])
  })
})
