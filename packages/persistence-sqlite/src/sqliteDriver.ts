// Ta-2 · SQLite 持久化实现（tauri-plugin-sql）—— 桌面壳下替换 IndexedDB（§5 Ta-2 / C1 / TaK1）。
// ---------------------------------------------------------------------------
// 背景：DK1 持久化范围 = 会话列表（SessionMeta）+ 每会话 checkpoints。桌面（Tauri）下用 SQLite：
//   前端经 @tauri-apps/plugin-sql 的 Database 执行 SQL，上层逻辑（persistenceBridge / hydrate）不变。
//   · 与 IndexedDB 版契约对齐：全 async、best-effort —— 底层报错时读退化为 []、写静默返回，绝不抛
//     （对齐 indexedDbDriver / sessionsPersistence 的降级语义，DK2）。
//   · history + sessions 共享同一个 db 连接：getDb() 惰性 load 一次 + 建表（memoized）。
//   · 只有 isTauri() 时才由 main.tsx 选用本实现；浏览器仍用 IndexedDB（本文件不做环境判定）。
//
// 本文件按职责拆成三份（T5，单一职责）：
//   · sqliteShared.ts：getDb() 惰性连接 + PRAGMA 调优（journal_mode=WAL / busy_timeout / synchronous）
//     + 建表，history/sessions 共用同一连接。
//   · sqliteHistoryDriver.ts：checkpoints 表的 HistoryDriver 实现。
//   · sqliteSessionsPersistence.ts：sessions/workspaces 单行 blob 的 SessionsPersistence 实现。
// 本文件是组合根：只拼出 createSqlitePersistence() 与测试用的 __resetSqliteForTest()，不含表结构
// 或 SQL 细节——具体表结构、PRAGMA 动机见上述三个文件各自的头部注释。

import type { HistoryDriver, SessionsPersistence } from '@web-agent/core/state/persistence'
import { sqliteHistoryDriver } from './sqliteHistoryDriver'
import { resetSqliteSessionsForTest, sqliteSessions } from './sqliteSessionsPersistence'
import { resetSqliteConnectionForTest } from './sqliteShared'

// 简介：创建 SQLite 支撑的持久化器（history + sessions），供桌面壳（Tauri）下替换 IndexedDB。
// 详情：两者共享 getDb() 的同一连接；方法签名与 HistoryDriver / SessionsPersistence 契约完全一致，
//   故 persistenceBridge / hydrate / main.tsx 只需按环境换注入实例，其余不动（TaK1）。
export function createSqlitePersistence(): {
  history: HistoryDriver
  sessions: SessionsPersistence
} {
  return { history: sqliteHistoryDriver, sessions: sqliteSessions }
}

// 仅测试用：清掉 memoized 连接 + legacy 清理标记，隔离用例之间的模块级状态。
export function __resetSqliteForTest(): void {
  resetSqliteConnectionForTest()
  resetSqliteSessionsForTest()
}
