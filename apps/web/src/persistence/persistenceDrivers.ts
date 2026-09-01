import {
  createIndexedDbHistoryLogDriver,
  createIndexedDbRecoveryDriver,
  createIndexedDbSessionsPersistence,
} from '@einfach-agent/persistence-idb'
import type { HistoryLogDriver, SqlExecutorLoader } from '@einfach-agent/core/state/persistence'
import type { AgentHistoryCapabilityProvider, AgentRolloutDriver } from '@einfach-agent/core/history'
import type { ResolvedHost } from '../host/resolveHost'
import { createServerAgentRolloutDriver } from './serverAgentRolloutDriver'
import { createServerAgentHistoryCapability } from './serverAgentHistoryCapability'

export type HostPersistenceDrivers = {
  sessions: ReturnType<typeof createIndexedDbSessionsPersistence>
  recovery: ReturnType<typeof createIndexedDbRecoveryDriver>
  /** 撤销日志；与 recovery 成对刷盘，缺它则撤销不跨刷新（状态不受影响）。 */
  historyLog: HistoryLogDriver
  /** Server-only append-only agent history; static browser persistence deliberately has no file driver. */
  agentRollout?: AgentRolloutDriver
  /** Server-only read capability; static bundles leave ToolContext history absent. */
  agentHistory?: AgentHistoryCapabilityProvider
}

/**
 * 装上 SQLite 那一组 driver，并把这一态的 SQL 执行面注入进去。
 *
 * 注入执行面与「这一态用 SQLite」的判断必须同处一地——分开写就会有「选了 SQLite 却没配执行面」
 * 的中间态。收的是 loader，所以这一行是同步生效的，具体的执行面实现要到第一次执行 SQL 时才被
 * 拉进模块图（HTTP 客户端惰性引入）。
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
    agentRollout: createServerAgentRolloutDriver(),
    agentHistory: createServerAgentHistoryCapability(),
  }
}

/**
 * Creates the full persistence driver bundle for one host instance.
 *
 * 两态各一组：
 *   · `server` —— SQLite，执行面是打到本机 Node 后端的 `POST /api/invoke/sqlite_*`，
 *     库文件由 host-node 的 `sqlite/databasePath.ts` 决定（浏览器与 CLI 共用同一份）。
 *   · `static` —— 没有后端，只剩 IndexedDB。
 * 判据是「这一态有没有 SQL 通路」，**不是**「有没有本机能力桥」：`static` 两者都没有，但
 * `server` 之所以有 SQL 通路，是因为下面那条命令路由真的存在，而不是因为它有桥。
 *
 * 【T1 删掉了什么】曾有第三态 `tauri`（SQLite，执行面是桌面 SQL 插件的原生通路），与 server
 * 共用同一个库文件——正是「两个宿主在同一台机器上交替使用」这条前提，让下面 W4 那段成立。
 *
 * ═══ W4 的 cursor 指纹：随 T1 自然消解，留一条记档 ═══
 * `read_workspace_run_index_page` 返回给模型的分页 cursor 形如 `v1-<字节数>-<16 位 hex>:<下标>`，
 * 那 16 位 hex 是整份 `runs.jsonl` 的指纹。W 线移植时 Rust 与 Node 两侧**铸法不同**（Rust 的
 * `DefaultHasher` vs Node 的 sha256 前 16 hex），而 P3 把两个宿主的会话库并到同一个文件之后，
 * 一个未用完的 cursor 就可能跨宿主被读到。P3 的裁决是「不对齐，接受可恢复的降级」：两侧都先比
 * snapshot 再比下标，撞上时模型收到的是 `run index changed while paging; refresh history`，与
 * 「文件在翻页途中真的被追加/压实」走同一条降级路径（从头重翻），不是数据损坏也不是静默错值；
 * 而要逐位对齐就得复刻一个**明文写着不保证跨版本稳定**的哈希，等于用一个不响的失败换掉一个会响
 * 的失败。**T1 之后 Rust 宿主整个消失，铸法只剩 Node 一种，这个窗口不复存在。**
 * 记档留着是因为那条取舍在将来真出现第二个宿主实现时仍然成立；那时的正解也已经想清楚了——让
 * snapshot 带上铸造者（例如版本段从 `v1-` 分叉），把不匹配落到
 * `run index cursor version is unsupported` 这条说得出病因的分支上。
 */
export async function createHostPersistenceDrivers(
  host: ResolvedHost,
): Promise<HostPersistenceDrivers> {
  if (host.kind === 'server') {
    return createSqliteDrivers(async () => (await import('./serverSqlExecutor')).loadServerSqlExecutor())
  }

  return {
    sessions: createIndexedDbSessionsPersistence(),
    recovery: createIndexedDbRecoveryDriver(),
    historyLog: createIndexedDbHistoryLogDriver(),
  }
}
