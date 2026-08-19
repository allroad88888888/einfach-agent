// 本宿主认识哪些「逻辑连接」
// ---------------------------------------------------------------------------
// 桌面侧今天在**同一个库文件**上开了两条互不相干的连接：`packages/persistence-sqlite`
// （会话 / 恢复快照 / 事务日志）与 `packages/observability-sqlite`（trace span 与 event），
// 两边各自 `Database.load('sqlite:web-agent.db')`、各自建表、各自发 PRAGMA，谁也不知道对方存在。
// Node 侧必须能表达同一件事，所以「打开哪个库文件」与「这是谁的连接」是**两个**参数：
// 前者是路径（databasePath.ts），后者就是这里的名字。
//
// 为什么不直接拿路径当键：那样两个消费方会共用同一条连接。今天它们的路径恰好相同，于是
// 「一个文件两条连接」这件事会在移植中悄悄消失——而 P4 要把 observability 收敛过来时，正需要
// 它还在（trace 写入是 best-effort、失败即丢，会话持久化不是；把两者压到一条连接上，
// 一方的 PRAGMA 调优、忙等超时与失败降级就会串到另一方头上）。名字也留出了「以后 trace 换一个
// 库文件」的余地：改的是 databasePath 的映射，不是所有调用点。
//
// 为什么是**封闭**词表而不是任意字符串：这两条命令要挂在 `POST /api/invoke/:command` 后面，
// 连接名来自外部载荷。开放字符串意味着一个拼错的名字会静默开出第三条连接（在同一个文件上），
// 症状是「写进去了但另一边读不到」；封闭词表让它当场失败。同 commandNames.ts 的判据。

/** 全部逻辑连接。顺序无意义，判定一律走 `isSqliteConnectionName`。 */
export const SQLITE_CONNECTION_NAMES = ['persistence', 'observability'] as const

/**
 * 逻辑连接名。
 *
 * · `persistence` —— `@web-agent/persistence-sqlite`：sessions / recovery_snapshots / history_log。
 * · `observability` —— `@web-agent/observability-sqlite`：trace_spans / trace_events。
 *   该包的 driver 与 reader 是两个模块，但共用这一个名字：它们读写同一批表，分成两条连接
 *   除了多一个文件句柄没有任何区别（桌面侧分成两条是 `Database.load` 的调用点恰好有两处，
 *   不是设计）。
 */
export type SqliteConnectionName = (typeof SQLITE_CONNECTION_NAMES)[number]

const connectionNameSet: ReadonlySet<string> = new Set(SQLITE_CONNECTION_NAMES)

/** 名字是否在词表内。用 Set 判定，天然不会被 `toString` / `constructor` 之类的原型键蒙混。 */
export function isSqliteConnectionName(value: unknown): value is SqliteConnectionName {
  return typeof value === 'string' && connectionNameSet.has(value)
}
