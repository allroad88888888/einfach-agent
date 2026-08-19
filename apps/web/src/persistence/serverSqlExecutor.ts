// server 宿主（浏览器 + 本机 Node 后端）的 SQL 执行面 —— P1 抽出的 `SqlExecutor` port 在这一态的实现。
// ---------------------------------------------------------------------------
// 与桌面态的 `tauriSqlExecutor.ts` 是兄弟文件：那边把 `@tauri-apps/plugin-sql` 的 `Database`
// 直接当执行面用，这边把两个方法各翻成一次 `POST /api/invoke/:command`。driver 包
// （`@einfach-agent/persistence-sqlite`）两边都不认识，只按契约用执行面。
//
// ═══ 为什么没有 `/api/sql` 这样一条专用端点（P3 的裁决） ═══
// P3 卡面写的改动面是「新建 `apps/server/src/sqlRoute*`」。**落地时没有新建端点，理由是它已经
// 存在**：P2 把 Node 侧的 SQL 执行定成了两条**命令**（`sqlite_execute` / `sqlite_select`），
// 并把它们登记进 `NODE_HOST_COMMANDS_BY_DOMAIN`、展开进 `createNodeHostInvoke` 的路由表
// （`packages/host-node/src/createNodeHostInvoke.ts` 的 `createSqliteRoutes(options)` 那一行）。
// 命令一旦在表里，S3 的 `POST /api/invoke/:command` 就已经在服务它们——登记进命令全集的**全部
// 目的**就是让那张统一路由表认得它（P2 的状态段原话：「必须回来登记进
// `NODE_HOST_COMMANDS_BY_DOMAIN`，否则分发层会以 `unknown-command` 拒绝它」）。
// 再开一条 `/api/sql` 得到的是**第二扇通往同一批 handler 的门**：第二处要正确接在认证之后、
// 第二套 body 上限与错误信封、第二处会随命令表漂移。而它换不来任何做不到的事。
// 「SQL 端点在不在认证之后」因此不是本文件的自觉，而是结构性的：这条路上没有别的门可走
// （回归网在 `apps/server/src/sqlRouteContract.test.ts`）。
//
// ═══ 为什么不复用 core 已登记的那座桥 ═══
// 语义上 `loadHostInvoke()` 拿到的就是同一个 `httpInvoke`，但它不在 `@einfach-agent/core` 的公开
// 面上，深导入 `@einfach-agent/core/runtime/hostBridge` 会撞 check-boundaries 的 core 公开面白名单
// （同 `host/hostCommandBridge.ts` 里那段「为什么不用 core 的 loadTauriInvoke()」）。这里直接用
// 装配层自己持有的那条 HTTP 客户端。
//
// ═══ 为什么用 `invokeServerCommand` 而不是 `httpInvoke` ═══
// `httpInvoke` 会把失败折叠成**裸字符串**（刻意与 Tauri invoke 的 reject 形状逐字一致）。而本文件
// 的下游是 `persistence-sqlite` 的三个 driver，它们一律 `catch (error)` 后按 `error.message` 记日志
// 或上抛；裸字符串在那里退化成 `String(error)`，一句准确的中文变成没有信息量的东西。
// `invokeServerCommand` 抛的是 `ServerInvokeError`（Error 子类，带 `status` / `code`），
// 与桌面态 `Database.load` 失败时抛 Error 的形状一致，两态的下游因此不用分叉。

import { invokeServerCommand } from '../host/serverInvoke'
import type { SqlExecuteResult, SqlExecutor } from '@einfach-agent/core/state/persistence'

/**
 * 逻辑连接名。与 `packages/host-node/src/sqlite/connectionNames.ts` 的封闭词表对应，
 * **本地声明而不是 import**：`@einfach-agent/host-node` 是 Node 侧能力包（`node:sqlite`、
 * `node:fs`），把它拖进浏览器构建图不成立。同 `serverInvoke.ts` 本地声明
 * `INVOKE_ROUTE_PREFIX` 的纪律——名字写错的后果是服务端当场受控失败（封闭词表），不是静默开出
 * 第三条连接。
 */
export type ServerSqlConnection = 'persistence' | 'observability'

/** 与 `packages/host-node/src/commandNames.ts` 的 `sqlite` 域两条对应。 */
const EXECUTE_COMMAND = 'sqlite_execute'
const SELECT_COMMAND = 'sqlite_select'

/**
 * 收窄 `sqlite_execute` 的回执。
 *
 * 不是形式主义：`rowsAffected` 正是恢复快照那条条件 UPSERT 用来区分 `saved` / `stale` /
 * `tombstoned` 三态的唯一依据（见 core 的 `SqlExecuteResult` 注释）。跨 HTTP 拿回来的是外部
 * JSON，形状不对时静默当成 0 的后果是「写成功了却被判成 stale」——那会表现成一次莫名其妙的
 * 快照丢弃，而且不报错。
 */
function narrowExecuteResult(payload: unknown): SqlExecuteResult {
  const rowsAffected = (payload as { rowsAffected?: unknown } | null)?.rowsAffected
  if (typeof rowsAffected !== 'number' || !Number.isFinite(rowsAffected)) {
    throw new Error(`本地服务的 SQL 回执缺少 rowsAffected：${JSON.stringify(payload)}`)
  }
  return { rowsAffected }
}

/**
 * 建一个打到本机 server 的执行面。
 *
 * 参数化 `connection` 是给 P4 留的：trace driver 走同一条 HTTP 路由、只换连接名
 * （两条连接读写同一个库文件里互不相干的两批表，理由见 host-node 的 connectionNames.ts）。
 */
export function createServerSqlExecutor(connection: ServerSqlConnection): SqlExecutor {
  return {
    async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
      return narrowExecuteResult(
        await invokeServerCommand<unknown>(EXECUTE_COMMAND, { connection, sql, params }),
      )
    },

    async select<Rows>(sql: string, params: unknown[] = []): Promise<Rows> {
      // 与 host-node 的执行面一样不校验行的形状：调用点用 `select<Row[]>(…)` 声明期望，
      // 那是编译期承诺；这一层假装校验过只会多一处要维护的第二权威。
      return await invokeServerCommand<Rows>(SELECT_COMMAND, { connection, sql, params })
    },
  }
}

/**
 * `SqlExecutorLoader` 形态，交给 `configureSqlExecutor`：会话 / 恢复快照 / 事务日志那条连接。
 *
 * 这里没有「打开」这一步（真正的打开在服务端第一次收到命令时发生），但仍然做成 loader：
 * 登记必须同步一步到位，形状由 P1 定死（见 core 的 sqlTransport.ts）。
 */
export async function loadServerSqlExecutor(): Promise<SqlExecutor> {
  return createServerSqlExecutor('persistence')
}
