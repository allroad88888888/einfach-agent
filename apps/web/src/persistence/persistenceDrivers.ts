import {
  createIndexedDbHistoryLogDriver,
  createIndexedDbRecoveryDriver,
  createIndexedDbSessionsPersistence,
} from '@web-agent/persistence-idb'
import type { HistoryLogDriver } from '@web-agent/core/state/persistence'

export type HostPersistenceDrivers = {
  sessions: ReturnType<typeof createIndexedDbSessionsPersistence>
  recovery: ReturnType<typeof createIndexedDbRecoveryDriver>
  /** 撤销日志；与 recovery 成对刷盘，缺它则撤销不跨刷新（状态不受影响）。 */
  historyLog: HistoryLogDriver
}

/** Creates the full persistence driver bundle for one web or Tauri host instance. */
export async function createHostPersistenceDrivers(
  tauriHost: boolean,
): Promise<HostPersistenceDrivers> {
  if (tauriHost) {
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
