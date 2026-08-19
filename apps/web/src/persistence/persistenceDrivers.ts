import {
  createIndexedDbHistoryLogDriver,
  createIndexedDbRecoveryDriver,
  createIndexedDbSessionsPersistence,
} from '@einfach-agent/persistence-idb'
import type { HistoryLogDriver, SqlExecutorLoader } from '@einfach-agent/core/state/persistence'
import type { ResolvedHost } from '../host/resolveHost'

export type HostPersistenceDrivers = {
  sessions: ReturnType<typeof createIndexedDbSessionsPersistence>
  recovery: ReturnType<typeof createIndexedDbRecoveryDriver>
  /** 撤销日志；与 recovery 成对刷盘，缺它则撤销不跨刷新（状态不受影响）。 */
  historyLog: HistoryLogDriver
}

/**
 * 装上 SQLite 那一组 driver，并把这一态的 SQL 执行面注入进去。
 *
 * 注入执行面与「这一态用 SQLite」的判断必须同处一地——分开写就会有「选了 SQLite 却没配执行面」
 * 的中间态。收的是 loader，所以这一行是同步生效的，具体的执行面实现要到第一次执行 SQL 时才被
 * 拉进模块图（桌面 SQL 插件 / HTTP 客户端各自惰性）。
 */
async function createSqliteDrivers(loadExecutor: SqlExecutorLoader): Promise<HostPersistenceDrivers> {
  const {
    configureSqlExecutor,
    createSqlitePersistence,
    createSqliteRecoveryDriver,
    createSqliteHistoryLogDriver,
  } = await import('@einfach-agent/persistence-sqlite')
  configureSqlExecutor(loadExecutor)
  return {
    ...createSqlitePersistence(),
    recovery: createSqliteRecoveryDriver(),
    historyLog: createSqliteHistoryLogDriver(),
  }
}

/**
 * Creates the full persistence driver bundle for one host instance.
 *
 * 三态各一组（P3 之前是二选一：只有桌面走 SQLite）：
 *   · `tauri`  —— SQLite，执行面是 `@tauri-apps/plugin-sql` 的原生通路。
 *   · `server` —— SQLite，执行面是打到本机 Node 后端的 `POST /api/invoke/sqlite_*`。
 *     库文件与桌面版**是同一个**（`…/com.webagent.app/web-agent.db`，见 host-node 的
 *     `sqlite/databasePath.ts`）：套壳（T 线）之前两个宿主会在同一台机器上交替使用，
 *     落进两个文件 = 用户看到两份互不相干的历史，而那不会报错。
 *   · `static` —— 没有后端，只剩 IndexedDB。
 * 判据是「这一态有没有 SQL 通路」，**不是**「有没有本机能力桥」：`static` 两者都没有，但
 * `server` 之所以有 SQL 通路，是因为下面那条命令路由真的存在，而不是因为它有桥。
 *
 * ═══ W4 的 cursor 指纹：本卡的裁决是「照旧，接受可恢复的降级」 ═══
 * 事实：`read_workspace_run_index_page` 返回给模型的分页 cursor 形如 `v1-<字节数>-<16 位 hex>:<下标>`，
 * 那 16 位 hex 是整份 `runs.jsonl` 的指纹，而**两个宿主铸法不同**——Rust 用
 * `std::collections::hash_map::DefaultHasher`（SipHash13），Node 用 sha256 前 16 hex
 * （`packages/host-node/src/workspace/read/runIndexRead.ts` 的 `runIndexSnapshot`）。
 * cursor 本身活在会话 items 里、随恢复快照落盘，所以**本卡把两个宿主的会话库并到同一个文件，
 * 正是「跨宿主 cursor 不会出现」这个前提失效的那一刻**（W4 交回时已点名要 P3 回来重新评估）。
 *
 * 裁决：不对齐，接受它。三条理由：
 *   ① **失败是响亮且可恢复的**。两侧都先比 snapshot 再比下标（Rust
 *      `workspace_read_run_index.rs:83`、Node `runIndexRead.ts` 同序），所以撞上时模型收到的是
 *      `run index changed while paging; refresh history` —— 与「文件在翻页途中真的被追加/压实」
 *      走的是同一条既定降级路径：从头重翻。不是数据损坏，也不是静默错值。
 *   ② **对齐反而更危险**。要逐位对齐就得在 Node 侧复刻 `DefaultHasher`，而 Rust 标准库明文
 *      写着它的内部算法「不保证跨版本稳定、不应被依赖」。那样换来的是：今天一致，某次 Rust
 *      升级后**静默**变得不一致——而不一致这件事本身没有任何征兆，只会表现成用户偶尔要多翻
 *      一次历史。用一个不响的失败换掉一个会响的失败，方向是反的。
 *   ③ **窗口有限**。撞上它要同时满足：同机交替使用桌面版与浏览器版、同一个 workspace、
 *      会话里正好存着一个未用完的 cursor、且模型恰好接着翻。而 T 线套壳后 Rust 宿主整个消失，
 *      两种铸法只剩一种。
 * 真要消除它，正解是让 snapshot 带上铸造者（例如版本段从 `v1-` 分叉），使不匹配落到
 * `run index cursor version is unsupported` 这条**说得出病因**的分支上——那要两个宿主一起改
 * 线上格式，不在本卡的改动面里，也不该由「接一下持久化」这张卡顺手改掉一个跨宿主契约。
 */
export async function createHostPersistenceDrivers(
  host: ResolvedHost,
): Promise<HostPersistenceDrivers> {
  if (host.kind === 'tauri') {
    return createSqliteDrivers(async () => (await import('./tauriSqlExecutor')).loadTauriSqlExecutor())
  }
  if (host.kind === 'server') {
    return createSqliteDrivers(async () => (await import('./serverSqlExecutor')).loadServerSqlExecutor())
  }

  return {
    sessions: createIndexedDbSessionsPersistence(),
    recovery: createIndexedDbRecoveryDriver(),
    historyLog: createIndexedDbHistoryLogDriver(),
  }
}
