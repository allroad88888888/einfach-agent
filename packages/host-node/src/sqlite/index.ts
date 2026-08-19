// sqlite 域的 registrar：Node 侧真正执行 SQL 的那一层
// ---------------------------------------------------------------------------
// 本域按 commandNames.ts 负责两条：`sqlite_execute` / `sqlite_select`。它们是 P1 的 `SqlExecutor`
// （`execute` / `select`）在**跨进程**那条路上的对应物——两个方法按「语句有没有返回行」分而不是
// 按读写分，命令也照这条线切，PRAGMA 因此走 select。
//
// 本域是 28 条 Rust 命令之外**新增**的一域：桌面侧的会话与 trace 持久化走
// `@tauri-apps/plugin-sql`，那是 Tauri 插件暴露的命令，不在本仓库的 `#[tauri::command]` 列表里。
// 所以这两条命令名由本卡自定并回登记进 commandNames.ts（那份文件原来就为它留了话）。
//
// 域内分层：
//   connectionNames.ts    ← 有哪些逻辑连接（persistence / observability）
//   databasePath.ts       ← 库文件在这台机器上的哪个位置（+ 本域装配槽）
//   connections.ts        ← 惰性打开与复用句柄（唯一一处 import node:sqlite）
//   statementShape.ts     ← 「一次调用只许是一条自包含语句」的机械判据
//   nodeSqliteExecutor.ts ← 把一个句柄包成 SqlExecutor（绑定、取行、错误包装）
//   commands.ts           ← 两条命令的入参收窄
//
// ═══ 本域交出两个面，形状不同、理由不同 ═══
// ① `createSqliteRoutes(options)` —— 路由表，给 HTTP（P3 的浏览器宿主）与 sidecar。
// ② `createNodeSqlExecutorLoader(options, connection)` —— **进程内**的执行面 loader，给 CLI
//    这类「宿主和 core 在同一个进程里」的装配：`configureSqlExecutor(loader)` 直接收它，
//    不必绕一圈 JSON 编解码。两个面共用同一张连接登记表（connections.ts 是模块级的），
//    所以同一个进程里两种用法不会在同一个库文件上开出两倍句柄。
//
// ═══ 没有第三个面 ═══
// 本域不导出事务、不导出批量、也不导出底层句柄。`SqlExecutor` 只承诺「收一条自包含语句、把它
// 执行掉」，连接归属留在实现里；多给一个 `transaction()` 就等于向所有调用方宣告「这几条会落在
// 同一条连接上」，而那正是这套设计刻意不再依赖的假设（判据见 core 的
// state/persistence/sqlTransport.ts，以及 statementShape.ts 里那三条机械判据）。

import { createSqliteExecuteHandler, createSqliteSelectHandler } from './commands'
import { loadSqliteExecutor } from './connections'
import { resolveSqliteDatabasePath } from './databasePath'
import type { SqliteConnectionName } from './connectionNames'
import type { SqliteRoutesOptions } from './databasePath'
import type { NodeHostRouteTable } from '../routeTable'
import type { SqlExecutor, SqlExecutorLoader } from '@einfach-agent/core/state/persistence'

export function createSqliteRoutes(options: SqliteRoutesOptions = {}): NodeHostRouteTable {
  return {
    sqlite_execute: createSqliteExecuteHandler(options),
    sqlite_select: createSqliteSelectHandler(options),
  }
}

/**
 * 进程内装配用的执行面 loader，直接交给 `configureSqlExecutor`。
 *
 * 收 loader 而不是已就绪的 executor，是 P1 定死的形状：登记必须是同步的、一步到位，真正打开
 * 库文件推迟到第一次用到。若在这里先 `await` 再登记，那段 await 期间「有没有 SQL 通路」仍答
 * 「没有」，而 driver 随时可能被调用——「driver 在注入完成前跑」于是从一个可以结构排除的问题
 * 退化成时序竞态（表现成「会话列表空了」这种看起来像数据丢失的假象）。
 */
export function createNodeSqlExecutorLoader(
  options: SqliteRoutesOptions,
  connection: SqliteConnectionName,
): SqlExecutorLoader {
  return (): Promise<SqlExecutor> =>
    loadSqliteExecutor(connection, resolveSqliteDatabasePath(options))
}

export { closeSqliteConnections } from './connections'
export { resolveSqliteDatabasePath } from './databasePath'
export { SQLITE_CONNECTION_NAMES, isSqliteConnectionName } from './connectionNames'
export type { SqliteConnectionName } from './connectionNames'
export type { SqliteRoutesOptions } from './databasePath'
