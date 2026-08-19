// SQL 执行 port —— 「怎么执行一条 SQL」的宿主中立契约（P1）。
// ---------------------------------------------------------------------------
// core 自己不执行 SQL，也不消费本文件里的任何类型：这份契约放在 core 是因为**可达性**。
// 它有四类消费方（SQLite 持久化 driver 包、宿主能力包、装配层，以及后续同款收敛的 trace
// driver 包），彼此之间没有依赖，唯一都已经依赖的东西就是 core。放进其中任何一个消费方，
// 都会逼出一条「driver 包 ← 宿主包」之类的反向箭头；另起一个只装三个接口的包，则要在
// vite alias / tsconfig paths / check-boundaries 两张表共四处登记。依赖方向
// `agent-ai ← agent-core ← 能力包 ← app` 因此一条都没动。
//
// 本文件是**宿主中立**的：整份源码里不出现任何具体 SQL 上游包的名字（连注释与 JSDoc 也不出现
// ——JSDoc 会被 tsc 原样带进发布物 .d.ts，同 runtime/hostBridge.ts 的同款纪律）。
//
// 【为什么粒度是「一条语句」而不是「一批语句」】
//   本仓库的 SQLite 写入有一条硬前提：**不能假设两次调用落在同一条连接上**。底层是连接池，
//   历史实现曾用多次独立调用发 BEGIN/DELETE/INSERT/COMMIT，语句被路由到池里不同连接，事务
//   根本不成立，还会把打开的写事务遗留在某条连接上长期持有写锁（真实烟测日志里表现为别的写
//   等到 busy_timeout 才超时）。当时的修法不是「把它们打包成一批」，而是让**每一次写入都是
//   一条自包含的原子语句**：会话列表是单行 blob upsert，恢复快照是条件 UPSERT，删除是
//   tombstone UPSERT，各自一条，SQLite 单语句本身即原子。
//   于是「批量」在这个代码库里从来不是调用方的能力，而是 SQL 语句自己的性质。把「一批语句」
//   做成 port 的一等概念，等于向所有实现宣告「这几条会一起执行」——那正是这里刻意不再依赖的
//   假设，而 port 本身给不出任何兑现它的手段（HTTP 那条路上更给不出）。所以 port 只承诺一件
//   事：**收一条语句，把它执行掉**；连接归属留在实现里，谁都不许对它做假设。

/**
 * 一条写语句的执行结果。
 *
 * 只收 `rowsAffected` 一个字段：调用方拿它判「条件 UPSERT 命中没有」（恢复快照的
 * `saved` / `stale` / `tombstoned` 三态就靠它区分）。自增主键之类的别的字段本仓库无人读，
 * 收进契约就是凭空给每个实现加一份必须兑现的承诺。
 */
export interface SqlExecuteResult {
  readonly rowsAffected: number
}

/**
 * 已就绪的 SQL 执行面。**一次调用 = 一条自包含语句**（理由见文件头）。
 *
 * 两个方法按「语句有没有返回行」分，而不是按读写分：
 *   · `execute`：无返回行的语句（DDL、INSERT/UPDATE/DELETE），回 `rowsAffected`。
 *   · `select`：有返回行的语句——除 SELECT 外还包括 PRAGMA，`journal_mode` / `busy_timeout`
 *     会各回一行当前值，走 `execute` 会被下游实现判成「非法语句」而报错。
 *
 * `select` 的**泛型形态必须保留**：调用点一律写成 `select<Row[]>(sql, params)`，换成非泛型
 * 签名会让那些带类型实参的调用点全体报错。
 */
export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<SqlExecuteResult>
  select<Rows>(sql: string, params?: unknown[]): Promise<Rows>
}

/**
 * 装配层登记的是 **loader（`() => Promise<SqlExecutor>`）而不是已就绪的 executor**，
 * 理由与 `runtime/hostBridge.ts` 的 HostInvokeLoader 逐字相同：拿到执行面本身是异步的
 * （同机宿主要先 await 一次动态 import 再打开数据库文件，远端宿主还要先握手）。若只收已解析值，
 * 装配层就得先 await 再登记，那段 await 期间「有没有 SQL 通路」仍答「没有」——而 driver 随时
 * 可能被调用，于是「driver 在注入完成前跑」从一个可以结构排除的问题退化成时序竞态：偶发、只在
 * 冷启动抢跑时命中、表现成「会话列表空了」这种看起来像数据丢失的假象。
 * 收 loader 则登记是同步的、一步到位，真正的打开推迟到第一次实际用到（也天然保住惰性）。
 */
export type SqlExecutorLoader = () => Promise<SqlExecutor>
