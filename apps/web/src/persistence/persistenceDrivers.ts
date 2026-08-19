import {
  createIndexedDbHistoryLogDriver,
  createIndexedDbRecoveryDriver,
  createIndexedDbSessionsPersistence,
} from '@web-agent/persistence-idb'
import type { HistoryLogDriver } from '@web-agent/core/state/persistence'
import type { ResolvedHost } from '../host/resolveHost'

export type HostPersistenceDrivers = {
  sessions: ReturnType<typeof createIndexedDbSessionsPersistence>
  recovery: ReturnType<typeof createIndexedDbRecoveryDriver>
  /** 撤销日志；与 recovery 成对刷盘，缺它则撤销不跨刷新（状态不受影响）。 */
  historyLog: HistoryLogDriver
}

/**
 * Creates the full persistence driver bundle for one host instance.
 *
 * SQLite 只有桌面端能用（走 `@tauri-apps/plugin-sql` 的原生通路）。server 宿主的 SQL 端点是
 * P 线（P1–P4）的事，在它落地之前浏览器侧只有 IndexedDB 一种耐久存储，server 与 static 因此
 * 拿同一组 driver——这里按「能不能直连 SQLite」分流，判据恰好就是宿主态。
 */
export async function createHostPersistenceDrivers(
  host: ResolvedHost,
): Promise<HostPersistenceDrivers> {
  if (host.kind === 'tauri') {
    const {
      createSqlitePersistence,
      createSqliteRecoveryDriver,
      createSqliteHistoryLogDriver,
    } = await import('@web-agent/persistence-sqlite')
    return {
      ...createSqlitePersistence(),
      recovery: createSqliteRecoveryDriver(),
      historyLog: createSqliteHistoryLogDriver(),
    }
  }

  return {
    sessions: createIndexedDbSessionsPersistence(),
    recovery: createIndexedDbRecoveryDriver(),
    historyLog: createIndexedDbHistoryLogDriver(),
  }
}
