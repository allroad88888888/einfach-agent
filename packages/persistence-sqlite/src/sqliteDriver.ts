// Ta-2 · SQLite 持久化实现 —— 桌面壳下替换 IndexedDB（§5 Ta-2 / C1 / TaK1）。
// ---------------------------------------------------------------------------
// 背景：持久化范围 = 会话列表（SessionMeta）+ 每会话 RecoverySnapshotV1。用 SQLite 落盘：
//   SQL 经装配层注入的 `SqlExecutor`（P1 的 port）执行，上层逻辑（persistenceBridge / hydrate）不变。
//   · 与 IndexedDB 版契约对齐：全 async、best-effort —— 底层报错时读退化为 []、写静默返回，绝不抛
//     （对齐 indexedDbDriver / sessionsPersistence 的降级语义，DK2）。
//   · history + sessions 共享同一个执行面：getDb() 惰性解析一次 + 建表（memoized）。
//   · 本包**不做环境判定、也不认识任何具体 SQL 上游包**：由装配层决定这一态用不用 SQLite，并把
//     对应的执行面 configureSqlExecutor 进来（桌面壳注入 Tauri SQL 插件）。
//
// 本文件按职责拆成三份（T5，单一职责）：
//   · sqliteShared.ts：执行面的注入槽（configureSqlExecutor）+ getDb() 惰性带起
//     （PRAGMA 调优 journal_mode=WAL / busy_timeout / synchronous + 建表），history/sessions 共用。
//   · sqliteSessionsPersistence.ts：sessions/workspaces 单行 blob 的 SessionsPersistence 实现。
// 本文件是组合根：只拼出 createSqlitePersistence() 与测试用的 __resetSqliteForTest()，不含表结构
// 或 SQL 细节——具体表结构、PRAGMA 动机见上述三个文件各自的头部注释。

import type { SessionsPersistence } from '@web-agent/core/state/persistence'
import { resetSqliteSessionsForTest, sqliteSessions } from './sqliteSessionsPersistence'
import { resetSqliteConnectionForTest } from './sqliteShared'

// 简介：创建 SQLite 支撑的持久化器（sessions），供桌面壳（Tauri）下替换 IndexedDB。
// 详情：方法签名与 SessionsPersistence 契约完全一致，故 persistenceBridge / hydrate / main.tsx
//   只需按环境换注入实例，其余不动（TaK1）。
export function createSqlitePersistence(): {
  sessions: SessionsPersistence
} {
  return { sessions: sqliteSessions }
}

// 仅测试用：清掉 memoized 连接 + legacy 清理标记，隔离用例之间的模块级状态。
export function __resetSqliteForTest(): void {
  resetSqliteConnectionForTest()
  resetSqliteSessionsForTest()
}
