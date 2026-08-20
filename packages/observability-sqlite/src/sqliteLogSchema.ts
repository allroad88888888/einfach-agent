// trace 两张表长什么样，以及怎么在一条执行面上把它们带起来
// ---------------------------------------------------------------------------
// 本文件只回答「表结构与它的带起来顺序」，不回答「执行面从哪来」（那是 sqliteLogTransport.ts）。
// 所以这里的每个函数都**收一个已就绪的 `SqlExecutor`**，自己不持有任何模块级状态——同一段
// 建表逻辑因此在 server（HTTP 打到本机 Node 后端）与进程内（CLI）两条执行面上逐字一致（T1 之前
// 还有桌面壳 Tauri SQL 插件那第三条执行面，已随桌面端一起删除）。
//
// ═══ 每一条都是**一条自包含语句** ═══
// `SqlExecutor` 只承诺「收一条语句、把它执行掉」，没有批量、没有事务（判据全文见 core 的
// state/persistence/sqlTransport.ts 文件头）。所以下面的 DDL 一条一个 `execute`，**不许**为了
// 少几次往返把它们用分号拼起来：node:sqlite 的 `prepare("A; B").run()` 会回一个 `{changes:1}`
// 的成功回执却只执行第一条（P2 实测），Node 宿主因此在执行前就把多语句判成非法输入
// （host-node 的 statementShape.ts）。P2 当年拼起来的后果是「桌面壳（Tauri）跑得通、换 server
// 宿主整段建表失败」——桌面端已随 T1 删除，但这条判据仍然成立：任何拼接写法都得先过 Node 宿主
// 这道闸，闸门本身与桌面壳的存亡无关。
//
// ═══ 三段 best-effort，各自的理由不同 ═══
// ① PRAGMA 调优：失败只是少了调优，读写不受影响。三条都可能**返回行**（journal_mode /
//    busy_timeout 会各回一行当前值），故走 `select` 而不是 `execute`——走错方法会被下游执行面
//    判成「非法语句」，整段调优静默失效。
// ② ALTER TABLE ADD COLUMN：给早于 session_id/run_id/turn_id 三列的旧库补列。列已存在时
//    SQLite 直接报错，那正是「不需要迁移」的正常情形，吞掉即可。
// ③ 遗留 running span 的收尾：见 recoverInterruptedSpans 的注释。

import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

const CREATE_SPANS_TABLE = `CREATE TABLE IF NOT EXISTS trace_spans (
   id TEXT PRIMARY KEY,
   trace_id TEXT NOT NULL,
   session_id TEXT,
   run_id TEXT,
   turn_id TEXT,
   parent_span_id TEXT,
   name TEXT NOT NULL,
   kind TEXT NOT NULL,
   status TEXT NOT NULL,
   started_at INTEGER NOT NULL,
   ended_at INTEGER,
   duration_ms INTEGER,
   attrs TEXT,
   error TEXT
 )`

const CREATE_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS trace_events (
   id TEXT PRIMARY KEY,
   trace_id TEXT NOT NULL,
   session_id TEXT,
   run_id TEXT,
   turn_id TEXT,
   span_id TEXT,
   name TEXT NOT NULL,
   timestamp INTEGER NOT NULL,
   attrs TEXT
 )`

/** 老库补列。列已存在时报错即「无需迁移」，逐条 best-effort。 */
const ADD_COLUMN_STATEMENTS = [
  'ALTER TABLE trace_spans ADD COLUMN session_id TEXT',
  'ALTER TABLE trace_spans ADD COLUMN run_id TEXT',
  'ALTER TABLE trace_spans ADD COLUMN turn_id TEXT',
  'ALTER TABLE trace_events ADD COLUMN session_id TEXT',
  'ALTER TABLE trace_events ADD COLUMN run_id TEXT',
  'ALTER TABLE trace_events ADD COLUMN turn_id TEXT',
] as const

const CREATE_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON trace_spans(trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_trace_spans_session_started ON trace_spans(session_id, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_trace_spans_run_id ON trace_spans(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_trace_events_trace_id ON trace_events(trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_trace_events_session_timestamp ON trace_events(session_id, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_trace_events_run_id ON trace_events(run_id)',
] as const

/**
 * 收掉上次进程遗留的 `running` span。
 *
 * 上次应用进程若在执行中被强退，trace 的正常 endSpan 没机会写回，数据库会永久显示 “running”。
 * 本函数只在**本进程第一条新 span 写入之前**跑一次（由 sqliteLogTransport.ts 的 memo 保证），
 * 因此只会收掉数据库里遗留的旧行。
 *
 * `$1` 在语句里出现两次而只传一个参数：这是**有意**的——node:sqlite 的具名绑定按「名字」而不是
 * 「位置」绑，同一个 `$1` 只需给一次值（host-node 的 nodeSqliteExecutor.ts 文件头点名了这条语句）。
 * T1 之前这条还要同时对齐桌面壳（Tauri）sqlx 的具名绑定；桌面端已随 T1 删除，写法本身不必再改，
 * 只是「两条执行面都兑现得了」收窄成了「现在只有 node:sqlite 这一条」。
 */
const RECOVER_RUNNING_SPANS = `UPDATE trace_spans
     SET status = 'cancelled',
         ended_at = $1,
         duration_ms = MAX(0, $1 - started_at),
         error = COALESCE(error, 'Recovered after application restart')
   WHERE status = 'running'`

async function bestEffortExecute(db: SqlExecutor, sql: string, params?: unknown[]): Promise<void> {
  try {
    await db.execute(sql, params)
  } catch {
    // 迁移 / 索引 / 遗留 trace 收尾都是 best-effort；失败不影响本进程的日志写入。
  }
}

/**
 * 在给定执行面上把 trace 的表结构带起来。调用方负责只跑一次（memo 在 sqliteLogTransport.ts）。
 *
 * 顺序即语义：调优 → 建表 → 补列 → 建索引 → 收遗留 running。建表必须在补列之前（新库靠建表
 * 就带齐了三列），索引必须在补列之后（`idx_trace_spans_session_started` 用到 session_id）。
 */
export async function bringUpTraceSchema(db: SqlExecutor): Promise<void> {
  try {
    await db.select('PRAGMA journal_mode=WAL')
    await db.select('PRAGMA busy_timeout=5000')
    await db.select('PRAGMA synchronous=NORMAL')
  } catch {
    // PRAGMA 调优失败不阻塞日志表初始化。
  }
  await db.execute(CREATE_SPANS_TABLE)
  await db.execute(CREATE_EVENTS_TABLE)
  for (const sql of ADD_COLUMN_STATEMENTS) await bestEffortExecute(db, sql)
  for (const sql of CREATE_INDEX_STATEMENTS) await db.execute(sql)
  await bestEffortExecute(db, RECOVER_RUNNING_SPANS, [Date.now()])
}
