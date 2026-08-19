// 本包那条 SQL 执行面：装配层从哪注入它，以及惰性把它（和表结构）带起来
// ---------------------------------------------------------------------------
// P4 之后本包**不再认识任何具体 SQL 上游包**：执行面由宿主装配层经 `configureTraceSqlExecutor`
// 注入，本包只按 P1 的 `SqlExecutor` 契约用它（桌面壳注入 Tauri SQL 插件、server 宿主注入打到
// 本机 Node 后端的 HTTP 执行面、CLI 注入进程内的 node:sqlite 执行面）。范式与逐条理由同
// packages/persistence-sqlite/src/sqliteShared.ts（P1）与 core 的 state/persistence/sqlTransport.ts。
//
// ═══ 为什么注入面不叫 `configureSqlExecutor` ═══
// persistence-sqlite 的同款入口就叫那个名字。两个包各自持有一份模块级 loader，是**两条**互不
// 相干的连接（同一个库文件上的两批表，理由见 host-node 的 sqlite/connectionNames.ts）。同名的
// 代价不在编译期——同一个文件里同时 import 两个同名导出会当场报错——而在装配层：一个
// `configureSqlExecutor(loader)` 读起来完全看不出配的是哪一半，写错的后果是「trace 表建在了
// persistence 那条连接上」这类不报错的错。名字里带 `Trace` 让它在调用点自己说清楚。
//
// ═══ 两个取用面，形状不同、理由不同 ═══
//   · `getTraceDb()`          —— 已建过表的执行面，给**写入端**（sqliteLogDriver.ts）。
//   · `loadTraceSqlExecutor()` —— 只解析、不建表，给**读取端**（sqliteLogReader.ts）。
// 读取端刻意不走建表那条路：那条路末尾有一句「把遗留的 running span 收为 cancelled」的 UPDATE，
// 而打开 TraceViewer 是只读动作，让它顺手改写数据库是实打实的行为变更（桌面侧今天也不会——
// reader 那边是另一次裸 `Database.load`，从不建表）。表还不存在时 SELECT 会失败，读取端按既有
// best-effort 收成空集，与 P4 之前逐字一致。
//
// ═══ 未注入时以 rejection 失败，不给兜底实现 ═══
// 形状与「宿主没有 SQL 运行时」逐字一致：都是本 promise reject。于是 driver 那两条 `catch` 的
// best-effort 降级、reader 那条上抛，一个字都不用改。

import type { SqlExecutor, SqlExecutorLoader } from '@einfach-agent/core/state/persistence'
import { bringUpTraceSchema } from './sqliteLogSchema'

/** 装配层登记的执行面 loader。未登记时两个取用面都以 rejection 失败。 */
let executorLoader: SqlExecutorLoader | undefined

/** 惰性 + memoized：整个进程只解析一次执行面。 */
let executorPromise: Promise<SqlExecutor> | undefined

/** 惰性 + memoized：整个进程只建一次表、只收一次遗留 running span。 */
let schemaPromise: Promise<SqlExecutor> | undefined

/**
 * 登记（或重置）本包使用的 SQL 执行面。宿主装配层在选用 SQLite trace 时调用一次，必须早于
 * 任何 span/event 可能被写入的时点；传 `undefined` 表示退回「没有执行面」。
 *
 * 登记会**作废已建立的缓存**（执行面与建表两份）：不作废的话，换宿主或运行期切换执行面都会
 * 继续用上一个 loader 解析出来的那条连接——那是「configure 看起来成功了、实际没生效」的静默
 * 错误。两份一起清也是必须的：只清执行面会让新连接上一张表都没有，而 SELECT 失败在读取端是
 * 静默的空集。
 */
export function configureTraceSqlExecutor(loader: SqlExecutorLoader | undefined): void {
  executorLoader = loader
  executorPromise = undefined
  schemaPromise = undefined
}

/**
 * 取（必要时解析）执行面本身，**不建表**。读取端用它。
 *
 * 缓存的是 promise 而不是结果：解析过程里有 await，缓存结果会让两次并发的首次调用各解析一次。
 * 失败则把 memo 撤掉允许重试；撤之前比对 promise 身份，免得旧的那次慢一步失败时清掉新的缓存。
 */
export async function loadTraceSqlExecutor(): Promise<SqlExecutor> {
  if (!executorPromise) {
    const pending = (async () => {
      const loader = executorLoader
      if (!loader) {
        throw new Error(
          'No SQL executor is configured; call configureTraceSqlExecutor(loader) during host assembly.',
        )
      }
      return loader()
    })()
    executorPromise = pending
    pending.catch(() => {
      if (executorPromise === pending) executorPromise = undefined
    })
  }
  return executorPromise
}

/**
 * 取（必要时解析并建表）执行面。写入端用它。
 *
 * 建表失败时清掉 memo 允许下次重试，并把错误透传给当前调用方去 best-effort 降级。
 */
export async function getTraceDb(): Promise<SqlExecutor> {
  if (!schemaPromise) {
    const pending = (async () => {
      const db = await loadTraceSqlExecutor()
      await bringUpTraceSchema(db)
      return db
    })()
    schemaPromise = pending
    pending.catch(() => {
      if (schemaPromise === pending) schemaPromise = undefined
    })
  }
  return schemaPromise
}

/**
 * 仅测试用：清掉两份 memo，隔离用例之间的模块级状态。
 *
 * 刻意**不**清掉已登记的 loader（同 persistence-sqlite 的 `resetSqliteConnectionForTest`）：
 * 测试在 beforeEach 里重新 configure 一个新的替身执行面，而清掉 loader 只会让「忘了 configure」
 * 表现成一堆 best-effort 的空结果，而不是一句明确的报错。
 */
export function __resetSqliteLogForTest(): void {
  executorPromise = undefined
  schemaPromise = undefined
}
