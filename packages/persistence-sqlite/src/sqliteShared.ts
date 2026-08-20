// Ta-2 · SQLite 持久化共享底座（拆分自 sqliteDriver.ts，T5）—— 本包那条 SQL 执行面：装配层从
// 哪注入它（configureSqlExecutor）、以及惰性把它带起来（PRAGMA 调优 + 建表）。
// sqliteHistoryLogDriver.ts、sqliteRecoveryDriver.ts 与 sqliteSessionsPersistence.ts 共用这同一
// 个执行面（getDb() 惰性解析一次 + 建表，memoized）。
//
// P1 之后本文件不再认识任何具体 SQL 上游包：执行面由宿主装配层经 configureSqlExecutor 注入
// （今天是 server 宿主，注入打到本机 Node 后端的 SQL 执行面；T1 之前还有桌面壳注入 Tauri SQL
// 插件那一条，已随桌面端一起删除；后续宿主注入各自的实现），本文件只按 `SqlExecutor` 契约用它。
//
// 连接调优（PRAGMA，见 getDb）：journal_mode=WAL + busy_timeout=5000 + synchronous=NORMAL。
//   动机（真实烟测日志）：底层是 sqlx **连接池**，历史实现用多次独立 db.execute
//   发 BEGIN/DELETE/INSERT/COMMIT —— 这些语句会被路由到池里**不同连接**，事务根本不成立，还会把
//   打开的写事务遗留在某条池化连接上长期持有写锁，别的写等到 busy_timeout(5s) 才超时
//   （日志特征：`slow statement: INSERT OR REPLACE INTO sessions … elapsed=5.21s rows_affected=0`）。
//   修复 = 彻底移除跨语句事务（sessions 改单行 blob，见 sqliteSessionsPersistence.ts）+ 开
//   WAL/超时/NORMAL 降低锁竞争与单写开销。
//   这条前提也是 `SqlExecutor` 只有「执行一条语句」而没有「执行一批语句」的原因，见 core 的
//   state/persistence/sqlTransport.ts 文件头。

import type { SqlExecutor, SqlExecutorLoader } from '@einfach-agent/core/state/persistence'
import { beginPerformanceDiagnostic, performanceNow } from '@einfach-agent/core/observability'

// 装配层登记的执行面 loader。未登记时 getDb() 以 rejection 失败（见下），各 driver 各自按既有
// 契约降级：sessions 静默 best-effort，recovery / historyLog 上抛。
let executorLoader: SqlExecutorLoader | undefined

// 惰性 + memoized 解析执行面并建表：整个进程只解析一次、建表一次。失败则抛（由各方法各自 catch 降级）。
let dbPromise: Promise<SqlExecutor> | undefined

/**
 * 登记（或重置）本包使用的 SQL 执行面。宿主装配层在选用 SQLite 持久化时调用一次，必须早于任何
 * driver 方法可能被调用的时点；传 `undefined` 表示退回「没有执行面」。
 *
 * 登记会**作废已建立的连接缓存**：不作废的话，换宿主或运行期切换执行面都会继续用上一个 loader
 * 解析出来的那条连接 —— 那是「configure 看起来成功了、实际没生效」的静默错误。
 */
export function configureSqlExecutor(loader: SqlExecutorLoader | undefined): void {
  executorLoader = loader
  dbPromise = undefined
}

export async function getDb(): Promise<SqlExecutor> {
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
        // 未登记执行面 = 装配错误，以 rejection 明确失败，不返回任何兜底实现（同 core 的
        // loadHostInvoke）。失败形状与「宿主没有 SQL 运行时」逐字一致：都是本 promise reject，
        // 下游那几条既有降级路径因此一个字都不用改。
        const loader = executorLoader
        if (!loader) {
          throw new Error(
            'No SQL executor is configured; call configureSqlExecutor(loader) during host assembly.',
          )
        }
        const db = await loader()
        loadMs = performanceNow() - phaseStartedAt
        // PRAGMA 连接调优（拿到执行面之后、建表之前）——best-effort：
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
          `CREATE TABLE IF NOT EXISTS recovery_snapshots (
             session_id TEXT PRIMARY KEY,
             generation INTEGER NOT NULL,
             deleted INTEGER NOT NULL,
             snapshot TEXT
           )`,
        )
        // 事务日志：每个 session 一行、整份覆盖。generation 单独成列而不是只埋在 payload 里，
        // 因为读回时的第一件事就是拿它和恢复快照比对；不匹配就不必反序列化 payload。
        await db.execute(
          `CREATE TABLE IF NOT EXISTS history_log (
             session_id TEXT PRIMARY KEY,
             generation INTEGER NOT NULL,
             payload TEXT NOT NULL
           )`,
        )
        // 轮级 undo 迁往 einfach 事务日志后，checkpoints 表已无人读写：直接丢弃。
        await db.execute('DROP TABLE IF EXISTS checkpoints')
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
// 刻意**不**清掉已登记的 loader：测试在 beforeEach 里重新 configure 一个新的 fake 执行面，而
// 清掉 loader 只会让「忘了 configure」表现成一堆 best-effort 的空结果，而不是一句明确的报错。
export function resetSqliteConnectionForTest(): void {
  dbPromise = undefined
}
