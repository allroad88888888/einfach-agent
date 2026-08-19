// Ta-2 · SQLite SessionsPersistence 实现（拆分自 sqliteDriver.ts，T5）—— 会话列表 + workspaces
// 的单行 blob 读写。与 IndexedDB 版契约对齐：全 async、best-effort —— 底层报错时读退化为 []、写
// 静默返回，绝不抛（对齐 indexedDbDriver / sessionsPersistence 的降级语义，DK2）。
//
// 表结构（meta 存 JSON 文本）：
//   sessions(id TEXT PRIMARY KEY, meta TEXT)  —— 会话列表 / workspaces 各存**单行 blob**：固定
//       id='__all__' / '__workspaces__'，meta 为整个数组的 JSON。单语句 upsert 天然原子，无需
//       跨语句事务（见 saveSessions 注释；PRAGMA/连接池背景见 sqliteShared.ts）。
//
// db 连接（getDb，含 PRAGMA 调优与建表）与 sqliteHistoryDriver.ts 共享，定义在 sqliteShared.ts。

import type { SessionMeta, WorkspaceMeta } from '@web-agent/core'
import type { SessionsPersistence } from '@web-agent/core/state/persistence'
import { beginPerformanceDiagnostic, performanceNow } from '@web-agent/core/observability'
import { getDb } from './sqliteShared'

// 会话列表单行 blob 的固定主键：整个 SessionMeta[] 序列化后存这一行的 meta 列。
const SESSIONS_BLOB_ID = '__all__'
const WORKSPACES_BLOB_ID = '__workspaces__'

// 上次 loadSessions 读到了旧的「逐行一个 meta」格式（或上次 legacy 清理中途崩溃遗留的死行）→ 置位，
// 下次 saveSessions 写完 '__all__' 单行后清一次死行（见 loadSessions / saveSessions 注释的原子性论证）。
let legacyRowsPendingCleanup = false

// 仅测试用：清掉 legacy 清理标记，隔离用例之间的模块级状态。与 sqliteShared.ts 的连接 reset 一起，
// 由 sqliteDriver.ts 的 __resetSqliteForTest 编排。
export function resetSqliteSessionsForTest(): void {
  legacyRowsPendingCleanup = false
}

export const sqliteSessions: SessionsPersistence = {
  // 单行 blob 落盘：把**整个** SessionMeta[] 序列化进固定 id='__all__' 的一行。
  //
  // 为什么不再用 BEGIN/DELETE/INSERT/COMMIT 事务（关键修复）：tauri-plugin-sql 底层是 sqlx
  //   连接池，每次 db.execute 可能落到**不同连接**上 —— BEGIN 与 COMMIT 不在同一连接，事务不成立，
  //   还会把打开的写事务遗留在某条池化连接上长期持有写锁，别的写等到 busy_timeout 才超时
  //   （真实日志：INSERT OR REPLACE INTO sessions … elapsed=5.21s rows_affected=0）。ROLLBACK 同理无效。
  //   改用**单条** upsert：SQLite 单语句本身即原子（要么整行写入、要么完全不写），无需任何事务包裹，
  //   失败时旧的 '__all__' 行原封不动、绝不出现半写或残留锁。
  //   P1 之后执行面由装配层注入（SqlExecutor），这条更是硬前提：port 只承诺「执行一条语句」，
  //   连接归属完全在实现里，调用方无从假设。判据见 core 的 state/persistence/sqlTransport.ts。
  //
  // legacy 死行清理（best-effort，无原子性要求）：仅当上次 load 读到旧的逐行格式时才发一条
  //   `DELETE FROM sessions WHERE id != '__all__'`。它与上面的 upsert 是**两条独立语句、不要求原子**：
  //   '__all__' 行已先落盘（权威），此处再删非 '__all__' 的旧行；即便两条之间崩溃，也只是多留几行死数据
  //   —— 读路径永远优先 '__all__'（见 loadSessions），故无正确性影响。
  //
  // 出错静默返回（best-effort，DK2）。
  async saveSessions(sessions, diagnosticOperationId) {
    const operation = beginPerformanceDiagnostic(
      'persistence.sqlite.sessions',
      { sessionCount: sessions.length },
      { slowMs: 100, operationId: diagnosticOperationId },
    )
    let dbReadyMs = 0
    let serializeMs = 0
    let executeMs = 0
    let cleanupMs = 0
    let jsonChars = 0
    try {
      let phaseStartedAt = performanceNow()
      const db = await getDb()
      dbReadyMs = performanceNow() - phaseStartedAt
      phaseStartedAt = performanceNow()
      const sessionsJson = JSON.stringify(sessions)
      serializeMs = performanceNow() - phaseStartedAt
      jsonChars = sessionsJson.length
      phaseStartedAt = performanceNow()
      await db.execute('INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)', [
        SESSIONS_BLOB_ID,
        sessionsJson,
      ])
      executeMs = performanceNow() - phaseStartedAt
      if (legacyRowsPendingCleanup) {
        phaseStartedAt = performanceNow()
        await db.execute(
          `DELETE FROM sessions WHERE id NOT IN ('${SESSIONS_BLOB_ID}', '${WORKSPACES_BLOB_ID}')`,
        )
        cleanupMs = performanceNow() - phaseStartedAt
        legacyRowsPendingCleanup = false
      }
      operation.finish('ok', { dbReadyMs, serializeMs, executeMs, cleanupMs, jsonChars })
    } catch (error) {
      operation.finish(
        'error',
        { dbReadyMs, serializeMs, executeMs, cleanupMs, jsonChars },
        error,
      )
      // best-effort：落盘失败不抛（DK2）。旧 '__all__' 行不受影响。
    }
  },

  // 取回全部会话：优先读 '__all__' 单行 blob；无该行则**兼容旧的逐行格式**（每行一个 meta）。
  //   读到任何非 '__all__' 行（旧格式、或上次 legacy 清理中途崩溃遗留的死行）→ 标记待清理，
  //   下次 saveSessions 写完 '__all__' 后统一清一次（旧库首次读仍能读到，之后即迁移为新格式）。
  //   空库/出错 → []。
  async loadSessions() {
    try {
      const db = await getDb()
      const rows = await db.select<{ id: string; meta: string }[]>('SELECT id, meta FROM sessions')
      if (rows.some((r) => r.id !== SESSIONS_BLOB_ID && r.id !== WORKSPACES_BLOB_ID)) {
        legacyRowsPendingCleanup = true
      }
      const blobRow = rows.find((r) => r.id === SESSIONS_BLOB_ID)
      if (blobRow) {
        const parsed = JSON.parse(blobRow.meta) as unknown
        return Array.isArray(parsed) ? (parsed as SessionMeta[]) : []
      }
      // 无 '__all__' → 纯旧格式（或空库）：逐行 parse。
      return rows
        .filter((r) => r.id !== WORKSPACES_BLOB_ID)
        .map((r) => JSON.parse(r.meta) as SessionMeta)
    } catch {
      return []
    }
  },

  async saveWorkspaces(workspaces) {
    const operation = beginPerformanceDiagnostic(
      'persistence.sqlite.workspaces',
      { workspaceCount: workspaces.length },
      { slowMs: 100 },
    )
    let dbReadyMs = 0
    let serializeMs = 0
    let executeMs = 0
    let jsonChars = 0
    try {
      let phaseStartedAt = performanceNow()
      const db = await getDb()
      dbReadyMs = performanceNow() - phaseStartedAt
      phaseStartedAt = performanceNow()
      const workspacesJson = JSON.stringify(workspaces)
      serializeMs = performanceNow() - phaseStartedAt
      jsonChars = workspacesJson.length
      phaseStartedAt = performanceNow()
      await db.execute(
        'INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)',
        [WORKSPACES_BLOB_ID, workspacesJson],
      )
      executeMs = performanceNow() - phaseStartedAt
      operation.finish('ok', { dbReadyMs, serializeMs, executeMs, jsonChars })
    } catch (error) {
      operation.finish('error', { dbReadyMs, serializeMs, executeMs, jsonChars }, error)
      // best-effort。
    }
  },

  async loadWorkspaces() {
    try {
      const db = await getDb()
      const rows = await db.select<{ id: string; meta: string }[]>(
        `SELECT id, meta FROM sessions WHERE id = '${WORKSPACES_BLOB_ID}'`,
      )
      const parsed = rows[0] ? JSON.parse(rows[0].meta) as unknown : []
      return Array.isArray(parsed) ? parsed as WorkspaceMeta[] : []
    } catch {
      return []
    }
  },
}
