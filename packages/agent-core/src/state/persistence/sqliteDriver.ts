// Ta-2 · SQLite 持久化实现（tauri-plugin-sql）—— 桌面壳下替换 IndexedDB（§5 Ta-2 / C1 / TaK1）。
// ---------------------------------------------------------------------------
// 背景：DK1 持久化范围 = 会话列表（SessionMeta）+ 每会话 checkpoints。桌面（Tauri）下用 SQLite：
//   前端经 @tauri-apps/plugin-sql 的 Database 执行 SQL，上层逻辑（persistenceBridge / hydrate）不变。
//   · 与 IndexedDB 版契约对齐：全 async、best-effort —— 底层报错时读退化为 []、写静默返回，绝不抛
//     （对齐 indexedDbDriver / sessionsPersistence 的降级语义，DK2）。
//   · history + sessions 共享同一个 db 连接：getDb() 惰性 load 一次 + 建表（memoized）。
//   · 只有 isTauri() 时才由 main.tsx 选用本实现；浏览器仍用 IndexedDB（本文件不做环境判定）。
//
// 表结构（items/meta 存 JSON 文本）：
//   sessions(id TEXT PRIMARY KEY, meta TEXT)  —— 会话列表存**单行 blob**：固定 id='__all__'，
//       meta 为整个 SessionMeta[] 的 JSON。单语句 upsert 天然原子，无需跨语句事务（见 sqliteSessions）。
//   checkpoints(session_id TEXT, turn_index INTEGER, label TEXT, created_at INTEGER, items TEXT,
//               PRIMARY KEY(session_id, turn_index))
//
// 连接调优（PRAGMA，见 getDb）：journal_mode=WAL + busy_timeout=5000 + synchronous=NORMAL。
//   动机（真实烟测日志）：tauri-plugin-sql 底层是 sqlx **连接池**，历史实现用多次独立 db.execute
//   发 BEGIN/DELETE/INSERT/COMMIT —— 这些语句会被路由到池里**不同连接**，事务根本不成立，还会把
//   打开的写事务遗留在某条池化连接上长期持有写锁，别的写等到 busy_timeout(5s) 才超时
//   （日志特征：`slow statement: INSERT OR REPLACE INTO sessions … elapsed=5.21s rows_affected=0`）。
//   修复 = 彻底移除跨语句事务（sessions 改单行 blob）+ 开 WAL/超时/NORMAL 降低锁竞争与单写开销。

import Database from '@tauri-apps/plugin-sql'
import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'

const DB_URL = 'sqlite:web-agent.db'

// 会话列表单行 blob 的固定主键：整个 SessionMeta[] 序列化后存这一行的 meta 列。
const SESSIONS_BLOB_ID = '__all__'

// checkpoints 表里一行的形状（select 回来的原始行）。
interface CheckpointRow {
  turn_index: number
  label: string
  created_at: number
  items: string
}

// 惰性 + memoized 打开 db 并建表：整个进程只 load 一次、建表一次。失败则抛（由各方法各自 catch 降级）。
let dbPromise: Promise<Database> | undefined

// 上次 loadSessions 读到了旧的「逐行一个 meta」格式（或上次 legacy 清理中途崩溃遗留的死行）→ 置位，
// 下次 saveSessions 写完 '__all__' 单行后清一次死行（见 loadSessions / saveSessions 注释的原子性论证）。
let legacyRowsPendingCleanup = false

async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load(DB_URL)
      // PRAGMA 连接调优（load 之后、建表之前）——best-effort：
      //   · journal_mode=WAL：读写并发不互斥、写不再全局锁库；该模式持久化在库文件头，跨池化连接生效。
      //   · busy_timeout=5000：抢锁时最多等 5s（而非立刻失败）。
      //   · synchronous=NORMAL：WAL 下安全且显著更快（少一次 fsync）。
      // 三条都可能有返回行（journal_mode/busy_timeout 会各回一行当前值），故用 db.select 执行，
      // 避免 execute 对「有返回行的语句」报错。任一条失败都不阻塞建表 —— 单写路径仍可用（只是少了调优）。
      try {
        await db.select('PRAGMA journal_mode=WAL')
        await db.select('PRAGMA busy_timeout=5000')
        await db.select('PRAGMA synchronous=NORMAL')
      } catch {
        // PRAGMA 失败降级：继续建表，读写不受影响（与本文件既有 best-effort 风格一致）。
      }
      await db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, meta TEXT NOT NULL)')
      await db.execute(
        `CREATE TABLE IF NOT EXISTS checkpoints (
           session_id TEXT NOT NULL,
           turn_index INTEGER NOT NULL,
           label TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           items TEXT NOT NULL,
           PRIMARY KEY (session_id, turn_index)
         )`,
      )
      return db
    })()
    // 建表失败时清掉 memo，允许下次重试（并把错误透传给当前调用方去降级）。
    dbPromise.catch(() => {
      dbPromise = undefined
    })
  }
  return dbPromise
}

// 仅测试用：清掉 memoized 连接 + legacy 清理标记，隔离用例之间的模块级状态。
export function __resetSqliteForTest(): void {
  dbPromise = undefined
  legacyRowsPendingCleanup = false
}

// 简介：创建 SQLite 支撑的持久化器（history + sessions），供桌面壳（Tauri）下替换 IndexedDB。
// 详情：两者共享 getDb() 的同一连接；方法签名与 HistoryDriver / createSessionsPersistence 完全一致，
//   故 persistenceBridge / hydrate / main.tsx 只需按环境换注入实例，其余不动（TaK1）。
export function createSqlitePersistence(): {
  history: HistoryDriver
  sessions: SessionsPersistence
} {
  return { history: sqliteHistoryDriver, sessions: sqliteSessions }
}

// —— 类型别名（避免循环 import；结构与 historyDriver.ts / sessionsPersistence.ts 对齐）——
interface HistoryDriver {
  listCheckpoints(sessionId: string): Promise<CheckpointMeta[]>
  loadCheckpoint(sessionId: string, turnIndex: number): Promise<Checkpoint | undefined>
  saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void>
  truncateAfter(sessionId: string, turnIndex: number): Promise<void>
  deleteSession(sessionId: string): Promise<void>
}
interface SessionsPersistence {
  saveSessions(sessions: SessionMeta[]): Promise<void>
  loadSessions(): Promise<SessionMeta[]>
}

const sqliteHistoryDriver: HistoryDriver = {
  async listCheckpoints(sessionId) {
    try {
      const db = await getDb()
      const rows = await db.select<CheckpointRow[]>(
        'SELECT turn_index, label, created_at FROM checkpoints WHERE session_id = $1 ORDER BY turn_index',
        [sessionId],
      )
      return rows.map((r) => ({ turnIndex: r.turn_index, label: r.label, createdAt: r.created_at }))
    } catch {
      return []
    }
  },

  async loadCheckpoint(sessionId, turnIndex) {
    try {
      const db = await getDb()
      const rows = await db.select<CheckpointRow[]>(
        'SELECT turn_index, label, created_at, items FROM checkpoints WHERE session_id = $1 AND turn_index = $2',
        [sessionId, turnIndex],
      )
      const row = rows[0]
      if (!row) return undefined
      return {
        turnIndex: row.turn_index,
        label: row.label,
        createdAt: row.created_at,
        items: JSON.parse(row.items),
      }
    } catch {
      return undefined
    }
  },

  async saveCheckpoint(sessionId, checkpoint) {
    try {
      const db = await getDb()
      await db.execute(
        `INSERT OR REPLACE INTO checkpoints (session_id, turn_index, label, created_at, items)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sessionId,
          checkpoint.turnIndex,
          checkpoint.label,
          checkpoint.createdAt,
          JSON.stringify(checkpoint.items),
        ],
      )
    } catch {
      // best-effort：落盘失败不抛（DK2）。
    }
  },

  async truncateAfter(sessionId, turnIndex) {
    try {
      const db = await getDb()
      await db.execute('DELETE FROM checkpoints WHERE session_id = $1 AND turn_index > $2', [
        sessionId,
        turnIndex,
      ])
    } catch {
      // best-effort。
    }
  },

  async deleteSession(sessionId) {
    try {
      const db = await getDb()
      await db.execute('DELETE FROM checkpoints WHERE session_id = $1', [sessionId])
    } catch {
      // best-effort。
    }
  },
}

const sqliteSessions: SessionsPersistence = {
  // 单行 blob 落盘：把**整个** SessionMeta[] 序列化进固定 id='__all__' 的一行。
  //
  // 为什么不再用 BEGIN/DELETE/INSERT/COMMIT 事务（关键修复）：tauri-plugin-sql 底层是 sqlx
  //   连接池，每次 db.execute 可能落到**不同连接**上 —— BEGIN 与 COMMIT 不在同一连接，事务不成立，
  //   还会把打开的写事务遗留在某条池化连接上长期持有写锁，别的写等到 busy_timeout 才超时
  //   （真实日志：INSERT OR REPLACE INTO sessions … elapsed=5.21s rows_affected=0）。ROLLBACK 同理无效。
  //   改用**单条** upsert：SQLite 单语句本身即原子（要么整行写入、要么完全不写），无需任何事务包裹，
  //   失败时旧的 '__all__' 行原封不动、绝不出现半写或残留锁。
  //
  // legacy 死行清理（best-effort，无原子性要求）：仅当上次 load 读到旧的逐行格式时才发一条
  //   `DELETE FROM sessions WHERE id != '__all__'`。它与上面的 upsert 是**两条独立语句、不要求原子**：
  //   '__all__' 行已先落盘（权威），此处再删非 '__all__' 的旧行；即便两条之间崩溃，也只是多留几行死数据
  //   —— 读路径永远优先 '__all__'（见 loadSessions），故无正确性影响。
  //
  // 出错静默返回（best-effort，DK2）。
  async saveSessions(sessions) {
    try {
      const db = await getDb()
      await db.execute(`INSERT OR REPLACE INTO sessions (id, meta) VALUES ('${SESSIONS_BLOB_ID}', $1)`, [
        JSON.stringify(sessions),
      ])
      if (legacyRowsPendingCleanup) {
        await db.execute(`DELETE FROM sessions WHERE id != '${SESSIONS_BLOB_ID}'`)
        legacyRowsPendingCleanup = false
      }
    } catch {
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
      if (rows.some((r) => r.id !== SESSIONS_BLOB_ID)) legacyRowsPendingCleanup = true
      const blobRow = rows.find((r) => r.id === SESSIONS_BLOB_ID)
      if (blobRow) {
        const parsed = JSON.parse(blobRow.meta) as unknown
        return Array.isArray(parsed) ? (parsed as SessionMeta[]) : []
      }
      // 无 '__all__' → 纯旧格式（或空库）：逐行 parse。
      return rows.map((r) => JSON.parse(r.meta) as SessionMeta)
    } catch {
      return []
    }
  },
}
