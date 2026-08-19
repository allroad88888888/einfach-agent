// 桌面壳（Tauri）的 SQL 执行面 —— P1 抽出的 `SqlExecutor` port 在这一态的实现。
// ---------------------------------------------------------------------------
// 这是仓库持久化链路上**唯一**一处 import `@tauri-apps/plugin-sql` 的生产代码：
// `@web-agent/persistence-sqlite` 只按契约用执行面，不再认识任何具体 SQL 上游包，于是同一份
// driver 逻辑能被后续宿主（Node 进程内 / server HTTP 端点）复用，各自在 persistence/ 下加一个
// 兄弟文件即可。
//
// 为什么整个模块被 persistenceDrivers.ts 动态 import：本文件一被求值就把桌面 SQL 插件拉进模块图，
// 而浏览器与 static 两态根本走不到 SQLite 那条分支。放在 configureSqlExecutor 收下的 loader 里
// 动态引入，插件的加载时点因此推迟到**第一次真的要执行 SQL**（比 P1 之前更晚一点，语义不变：
// 插件模块求值本身没有副作用，真正打开数据库的是下面这次 `Database.load`）。
//
// `Database` 的 `execute` / `select` 签名与 `SqlExecutor` 结构一致（`QueryResult` 比
// `SqlExecuteResult` 多一个 `lastInsertId`，多出来的成员不影响赋值），故直接返回实例即可，
// 无需包一层转接。

import Database from '@tauri-apps/plugin-sql'
import type { SqlExecutor } from '@web-agent/core/state/persistence'

// 相对路径：Tauri SQL 插件把它解析到桌面应用的数据目录下（com.webagent.app/web-agent.db）。
// 这个「用哪个库文件」的决定天然属于宿主，P1 把它从 driver 包搬到装配层的原因也在此。
const DB_URL = 'sqlite:web-agent.db'

/** `SqlExecutorLoader` 形态：交给 configureSqlExecutor，首次执行 SQL 时才真正打开库。 */
export async function loadTauriSqlExecutor(): Promise<SqlExecutor> {
  return Database.load(DB_URL)
}
