// 把一个已打开的 SQLite 句柄包成 P1 的 `SqlExecutor`
// ---------------------------------------------------------------------------
// 这一层只回答「怎么执行**一条**语句」。打开哪个文件、什么时候打开、谁和谁共用一条连接，
// 全在 connections.ts；判据「这条 SQL 合不合法」在 statementShape.ts。
//
// ═══ 公开面就是 `execute` / `select` 两个方法，没有第三个 ═══
// 返回的对象里**没有** transaction、没有 batch、也没有把底层句柄漏出去的任何入口。这不是省事：
// port 只承诺「收一条语句、把它执行掉」，连接归属完全留在实现里，调用方无从假设——多给一个
// `transaction()`，就等于向所有调用方宣告「这几条会落在同一条连接上」，而那正是这套设计刻意
// 不再依赖的假设（HTTP 那条路上更给不出）。理由全文见 core 的 state/persistence/sqlTransport.ts。
//
// ═══ 绑定为什么走「具名」而不是「位置」 ═══
// port 的入参是位置数组，仓库现有 SQL 用的是 sqlx 风格的 `$1`/`$2`。node:sqlite 的匿名绑定会
// **跳过所有带名字的参数**——而 `$1` 在 SQLite 眼里是有名字的（名字就是 `$1`），于是
// `run('x')` 当场 SQLITE_RANGE「column index out of range」。改用具名对象 `{ '$1': … }` 后
// 一切正常，还顺带对了两件位置绑定做不到的事：同一个 `$1` 在语句里出现两次时只需一个值
// （`observability-sqlite` 的 `ended_at = $1, duration_ms = MAX(0, $1 - started_at)` 就是），
// 以及多传/漏传参数会当场报错而不是静默绑成 NULL。
// 键写成带前缀的 `'$1'` 而不是裸 `'1'`：裸名依赖 node:sqlite 的 `allowBareNamedParameters`
// 默认值，带前缀的形式与那个开关无关。

import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type { SqlExecuteResult, SqlExecutor } from '@web-agent/core/state/persistence'
import { inspectSingleStatement } from './statementShape'

/**
 * 把位置数组里的一个值转成可绑定的值。
 *
 * `undefined` → NULL 是**对齐桌面宿主**：那条路上入参要经 Tauri IPC 的 JSON 序列化，
 * `undefined` 到不了 Rust，落地就是 null。这里若原样抛错，同一份调用代码会「进程内注入时报错、
 * 走 HTTP 时正常」。布尔同理（sqlx 把 bool 绑成 0/1）。
 *
 * 其余类型（对象、数组、函数、NaN/Infinity）一律受控失败：它们在 SQLite 里没有对应的存储类，
 * 猜一个（比如 `JSON.stringify`）等于替调用方决定编码方式，而读回来时没人再解它。
 */
function toBindValue(value: unknown, position: number): SQLInputValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`第 ${position} 个参数是 ${value}，SQLite 无法存储`)
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (ArrayBuffer.isView(value)) return value as SQLInputValue
  throw new Error(`第 ${position} 个参数的类型（${typeof value}）无法绑定到 SQLite`)
}

/** 位置数组 → node:sqlite 的具名绑定对象。`$1` 对应 `params[0]`，与 sqlx 的编号一致。 */
function toBindings(params: readonly unknown[]): Record<string, SQLInputValue> {
  const bindings: Record<string, SQLInputValue> = {}
  for (const [index, value] of params.entries()) {
    bindings[`$${index + 1}`] = toBindValue(value, index + 1)
  }
  return bindings
}

/** 编译一条语句，并在编译之前把三条判据走完（只有一条语句、不是事务控制、占位符对得上）。 */
function prepareOne(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): { statement: StatementSync; bindings: Record<string, SQLInputValue> | undefined } {
  const shape = inspectSingleStatement(sql)
  if (shape.parameterCount !== params.length) {
    // 少传的那一头尤其要挡：node:sqlite 会把没绑到的 `$1` 静默当成 NULL，一次查询于是安静地
    // 返回空集，而调用方看到的是「数据不见了」。
    throw new Error(
      `SQL 需要 ${shape.parameterCount} 个参数，实际传入 ${params.length} 个`,
    )
  }
  return {
    statement: database.prepare(sql),
    // 零参数时不传绑定对象：让 `run()` / `all()` 走它们最朴素的那条重载。
    bindings: shape.parameterCount === 0 ? undefined : toBindings(params),
  }
}

/**
 * 把 SQLite 抛出的错误重新包一层，带上是哪条连接出的事。
 *
 * 原错误挂在 `cause` 上而不是丢掉：`ERR_SQLITE_ERROR` 上的 `errcode` / `errstr` 是排查
 * 「是不是被锁住了」这类问题的唯一线索。
 */
function wrapFailure(connectionLabel: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`SQLite（${connectionLabel}）执行失败：${detail}`, { cause: error })
}

/**
 * 建一个执行面。`connectionLabel` 只用于错误文案（形如 `persistence@/…/web-agent.db`）。
 *
 * node:sqlite 是**同步**接口，两个方法因此在 async 外壳里同步完成——这也意味着一次调用期间
 * 不会有别的 JS 插进来改动同一个句柄，无需额外串行化。
 */
export function createSqliteExecutor(database: DatabaseSync, connectionLabel: string): SqlExecutor {
  return {
    async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
      try {
        const { statement, bindings } = prepareOne(database, sql, params)
        const result = bindings ? statement.run(bindings) : statement.run()
        return { rowsAffected: Number(result.changes) }
      } catch (error) {
        throw wrapFailure(connectionLabel, error)
      }
    },

    async select<Rows>(sql: string, params: unknown[] = []): Promise<Rows> {
      try {
        const { statement, bindings } = prepareOne(database, sql, params)
        const rows = bindings ? statement.all(bindings) : statement.all()
        // node:sqlite 给的行是 **null 原型**对象。展平成普通对象是为了让两种传输给出同一种东西：
        // 走 HTTP 时行会被 JSON 序列化再解析，那一头拿到的必然是普通对象；进程内注入若原样返回
        // null 原型对象，「本地能跑、上 server 就变」的差异又多一处。
        // 已知不覆盖的一类：BLOB 列会是 Uint8Array，JSON 化之后变成下标对象。本仓库两个 schema
        // 里没有 BLOB 列（会话与快照都以 TEXT 存 JSON），所以这里不写一段没有调用方的转换。
        return rows.map((row) => ({ ...row })) as Rows
      } catch (error) {
        throw wrapFailure(connectionLabel, error)
      }
    },
  }
}
