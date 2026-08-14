// Ta-2 · SQLite 持久化共享底座（拆分自 sqliteDriver.ts，T5）—— 惰性打开 db 连接、PRAGMA 调优、
// 建表；sqliteHistoryDriver.ts 与 sqliteSessionsPersistence.ts 共用这同一个连接（history + sessions
// 共享同一个 db 连接：getDb() 惰性 load 一次 + 建表，memoized）。
//
// 连接调优（PRAGMA，见 getDb）：journal_mode=WAL + busy_timeout=5000 + synchronous=NORMAL。
//   动机（真实烟测日志）：tauri-plugin-sql 底层是 sqlx **连接池**，历史实现用多次独立 db.execute
//   发 BEGIN/DELETE/INSERT/COMMIT —— 这些语句会被路由到池里**不同连接**，事务根本不成立，还会把
//   打开的写事务遗留在某条池化连接上长期持有写锁，别的写等到 busy_timeout(5s) 才超时
//   （日志特征：`slow statement: INSERT OR REPLACE INTO sessions … elapsed=5.21s rows_affected=0`）。
//   修复 = 彻底移除跨语句事务（sessions 改单行 blob，见 sqliteSessionsPersistence.ts）+ 开
//   WAL/超时/NORMAL 降低锁竞争与单写开销。

import Database from '@tauri-apps/plugin-sql'
import { beginPerformanceDiagnostic, performanceNow } from '@web-agent/core/observability'

const DB_URL = 'sqlite:web-agent.db'

// 惰性 + memoized 打开 db 并建表：整个进程只 load 一次、建表一次。失败则抛（由各方法各自 catch 降级）。
let dbPromise: Promise<Database> | undefined

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const operation = beginPerformanceDiagnostic(
        'persistence.sqlite.initialize',
        { database: 'web-agent.db' },
        { slowMs: 250 },
      )
      let loadMs = 0
      let pragmaMs = 0
      let schemaMs = 0
      try {
        let phaseStartedAt = performanceNow()
        const db = await Database.load(DB_URL)
        loadMs = performanceNow() - phaseStartedAt
        // PRAGMA 连接调优（load 之后、建表之前）——best-effort：
        //   · journal_mode=WAL：读写并发不互斥、写不再全局锁库；该模式持久化在库文件头，跨池化连接生效。
        //   · busy_timeout=5000：抢锁时最多等 5s（而非立刻失败）。
        //   · synchronous=NORMAL：WAL 下安全且显著更快（少一次 fsync）。
        // 三条都可能有返回行（journal_mode/busy_timeout 会各回一行当前值），故用 db.select 执行，
        // 避免 execute 对「有返回行的语句」报错。任一条失败都不阻塞建表 —— 单写路径仍可用（只是少了调优）。
        phaseStartedAt = performanceNow()
        let pragmaTuningSucceeded = true
        try {
          await db.select('PRAGMA journal_mode=WAL')
          await db.select('PRAGMA busy_timeout=5000')
          await db.select('PRAGMA synchronous=NORMAL')
        } catch {
          pragmaTuningSucceeded = false
          // PRAGMA 失败降级：继续建表，读写不受影响（与本文件既有 best-effort 风格一致）。
        }
        pragmaMs = performanceNow() - phaseStartedAt
        phaseStartedAt = performanceNow()
        await db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, meta TEXT NOT NULL)')
        await db.execute(
          `CREATE TABLE IF NOT EXISTS checkpoints (
             session_id TEXT NOT NULL,
             turn_index INTEGER NOT NULL,
             label TEXT NOT NULL,
             kind TEXT,
             finish_reason TEXT,
             created_at INTEGER NOT NULL,
             items TEXT NOT NULL,
             plan TEXT,
             recovery TEXT,
             plan_stage_checkpoints TEXT,
             context_checkpoint TEXT,
             PRIMARY KEY (session_id, turn_index)
           )`,
        )
        await db.execute(
          `CREATE TABLE IF NOT EXISTS recovery_snapshots (
             session_id TEXT PRIMARY KEY,
             generation INTEGER NOT NULL,
             deleted INTEGER NOT NULL,
             snapshot TEXT
           )`,
        )
        // 兼容旧桌面数据库：CREATE TABLE IF NOT EXISTS 不会给既有表补列。
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN plan TEXT')
        } catch {
          // 新库已经包含 plan，或旧库迁移已完成；两种情况都可继续。
        }
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN recovery TEXT')
        } catch {
          // 新库已经包含 recovery，或旧库迁移已完成；两种情况都可继续。
        }
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN plan_stage_checkpoints TEXT')
        } catch {
          // 新库已经包含 plan_stage_checkpoints，或旧库迁移已完成；两种情况都可继续。
        }
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN context_checkpoint TEXT')
        } catch {
          // 新库已经包含 context_checkpoint，或旧库迁移已完成；两种情况都可继续。
        }
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN kind TEXT')
        } catch {
          // 新库已经包含 kind，或旧库迁移已完成；两种情况都可继续。
        }
        try {
          await db.execute('ALTER TABLE checkpoints ADD COLUMN finish_reason TEXT')
        } catch {
          // 新库已经包含 finish_reason，或旧库迁移已完成；两种情况都可继续。
        }
        schemaMs = performanceNow() - phaseStartedAt
        operation.finish('ok', {
          loadMs,
          pragmaMs,
          schemaMs,
          pragmaTuningSucceeded,
        })
        return db
      } catch (error) {
        operation.finish('error', { loadMs, pragmaMs, schemaMs }, error)
        throw error
      }
    })()
    // 建表失败时清掉 memo，允许下次重试（并把错误透传给当前调用方去降级）。
    dbPromise.catch(() => {
      dbPromise = undefined
    })
  }
  return dbPromise
}

// 仅测试用：清掉 memoized 连接，隔离用例之间的模块级状态。与 sqliteSessionsPersistence.ts 的
// legacy 清理标记 reset 一起，由 sqliteDriver.ts 的 __resetSqliteForTest 编排。
export function resetSqliteConnectionForTest(): void {
  dbPromise = undefined
}
