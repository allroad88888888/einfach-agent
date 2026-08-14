import {
  createIndexedDbHistoryDriver,
  createIndexedDbRecoveryDriver,
  createIndexedDbSessionsPersistence,
} from '@web-agent/persistence-idb'

export type HostPersistenceDrivers = {
  history: ReturnType<typeof createIndexedDbHistoryDriver>
  sessions: ReturnType<typeof createIndexedDbSessionsPersistence>
  recovery: ReturnType<typeof createIndexedDbRecoveryDriver>
}

/** Creates the full persistence driver bundle for one web or Tauri host instance. */
export async function createHostPersistenceDrivers(
  tauriHost: boolean,
): Promise<HostPersistenceDrivers> {
  if (tauriHost) {
    const { createSqlitePersistence, createSqliteRecoveryDriver } = await import('@web-agent/persistence-sqlite')
    return { ...createSqlitePersistence(), recovery: createSqliteRecoveryDriver() }
  }

  return {
    history: createIndexedDbHistoryDriver(),
    sessions: createIndexedDbSessionsPersistence(),
    recovery: createIndexedDbRecoveryDriver(),
  }
}
