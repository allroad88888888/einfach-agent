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
//   sessions(id TEXT PRIMARY KEY, meta TEXT)  —— 覆盖式落盘（DELETE 全部 + INSERT）
//   checkpoints(session_id TEXT, turn_index INTEGER, label TEXT, created_at INTEGER, items TEXT,
//               PRIMARY KEY(session_id, turn_index))

import Database from '@tauri-apps/plugin-sql'
import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'

const DB_URL = 'sqlite:web-agent.db'

// checkpoints 表里一行的形状（select 回来的原始行）。
interface CheckpointRow {
  turn_index: number
  label: string
  created_at: number
  items: string
}

// 惰性 + memoized 打开 db 并建表：整个进程只 load 一次、建表一次。失败则抛（由各方法各自 catch 降级）。
let dbPromise: Promise<Database> | undefined

async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load(DB_URL)
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

// 仅测试用：清掉 memoized 连接，隔离用例之间的模块级状态。
export function __resetSqliteForTest(): void {
  dbPromise = undefined
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
  // 覆盖式落盘：DELETE 全部 + 逐个 INSERT，落盘结果与传入列表一致（删掉的会话不残留）。
  // **事务原子**（codex P2）：DELETE 与 INSERT 包在 BEGIN/COMMIT 里 —— 任一步失败则 ROLLBACK，
  //   绝不让「DELETE 已提交、INSERT 失败」把权威会话列表清空（否则重启后会话不可达、checkpoint 变孤儿）。
  //   出错静默返回（best-effort，DK2）。
  async saveSessions(sessions) {
    let db: Database
    try {
      db = await getDb()
    } catch {
      return
    }
    try {
      await db.execute('BEGIN')
      await db.execute('DELETE FROM sessions')
      for (const session of sessions) {
        await db.execute('INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)', [
          session.id,
          JSON.stringify(session),
        ])
      }
      await db.execute('COMMIT')
    } catch {
      try {
        await db.execute('ROLLBACK')
      } catch {
        // ROLLBACK 本身失败也吞掉（best-effort）。
      }
    }
  },

  // 取回全部会话（meta 反序列化）；空库/出错 → []。
  async loadSessions() {
    try {
      const db = await getDb()
      const rows = await db.select<{ meta: string }[]>('SELECT meta FROM sessions')
      return rows.map((r) => JSON.parse(r.meta) as SessionMeta)
    } catch {
      return []
    }
  },
}
