// 两条命令的入参收窄与执行
// ---------------------------------------------------------------------------
// 路由表的 handler 收到的是 `Record<string, unknown>`：同一张表要同时挂在
// `POST /api/invoke/:command`（载荷来自浏览器发的 JSON，是外部输入）、CLI 进程内注入与 Tauri
// sidecar 后面。commandArgs.ts 里的 `SqliteExecuteArgs` / `SqliteSelectArgs` 是收窄的**目标形状**，
// 不是收窄的替代品，所以这里逐字段判。
//
// 判存在只看值、不用 `'key' in args`：core 侧的入参构造函数是整份对象字面量返回，可选项没有值
// 时键**存在且为 undefined**；进程内注入时这些键原样到达，走 HTTP 时 `JSON.stringify` 会把它们
// 丢掉。同一份入参在两种传输下键集合不同，用 `in` 判断会写出「本地能跑、上 server 就变」的 bug。
//
// SQL 本身不在这里判——「是不是一条自包含语句」由 statementShape.ts 在执行前统一判，两条命令
// 共用同一套判据（execute 与 select 只差「要不要取回行」，不该各有各的合法性口径）。

import { isSqliteConnectionName, SQLITE_CONNECTION_NAMES } from './connectionNames'
import { loadSqliteExecutor } from './connections'
import { resolveSqliteDatabasePath, type SqliteRoutesOptions } from './databasePath'
import type { SqliteConnectionName } from './connectionNames'
import type { NodeHostCommandHandler } from '../routeTable'

interface SqlRequest {
  readonly connection: SqliteConnectionName
  readonly sql: string
  readonly params: unknown[]
}

function narrowSqlRequest(args: Record<string, unknown>): SqlRequest {
  const connection = args.connection
  if (!isSqliteConnectionName(connection)) {
    throw new Error(
      `sqlite 命令的 connection 必须是 ${SQLITE_CONNECTION_NAMES.join(' / ')} 之一，` +
        `收到：${JSON.stringify(connection)}`,
    )
  }
  const sql = args.sql
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('sqlite 命令的 sql 必须是非空字符串')
  }
  const params = args.params
  if (params === undefined) return { connection, sql, params: [] }
  if (!Array.isArray(params)) {
    throw new Error('sqlite 命令的 params 必须是数组（位置参数，对应 SQL 里的 $1、$2 …）')
  }
  return { connection, sql, params }
}

/**
 * `sqlite_execute`：执行一条不取行的语句，回 `{ rowsAffected }`。
 *
 * 库文件路径**每次调用现解析**，与 config 域每条命令现读 `WEB_AGENT_CONFIG_DIR` 同理：装配时
 * 解析死的话，一个不合法的 `databasePath` 会在装配期抛错、连累另外 29 条命令，而它其实只该
 * 让这两条失败。解析出的路径相同则连接被复用（登记表按路径记账），所以这不会多开句柄。
 */
export function createSqliteExecuteHandler(options: SqliteRoutesOptions): NodeHostCommandHandler {
  return async (args) => {
    const request = narrowSqlRequest(args)
    const executor = await loadSqliteExecutor(request.connection, resolveSqliteDatabasePath(options))
    return executor.execute(request.sql, request.params)
  }
}

/**
 * `sqlite_select`：执行一条取行的语句，回一个行数组。
 *
 * PRAGMA 也走这条：`journal_mode` / `busy_timeout` 会各回一行当前值（判据见 P1 的
 * `SqlExecutor` 注释）。`synchronous=NORMAL` 不回行，返回空数组即可，不是错误。
 */
export function createSqliteSelectHandler(options: SqliteRoutesOptions): NodeHostCommandHandler {
  return async (args) => {
    const request = narrowSqlRequest(args)
    const executor = await loadSqliteExecutor(request.connection, resolveSqliteDatabasePath(options))
    return executor.select<unknown[]>(request.sql, request.params)
  }
}
