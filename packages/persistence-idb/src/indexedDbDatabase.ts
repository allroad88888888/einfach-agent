// web-agent-history 的 IndexedDB 架构版本与打开逻辑。

export const DEFAULT_HISTORY_DB_NAME = 'web-agent-history'
export const HISTORY_DB_VERSION = 5
export const RECOVERY_SNAPSHOT_STORE_NAME = 'recoverySnapshots'
export const HISTORY_LOG_STORE_NAME = 'historyJournal'

/** Creates current stores without importing or deleting old records. */
export function openIndexedDbHistoryDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, HISTORY_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(RECOVERY_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(RECOVERY_SNAPSHOT_STORE_NAME, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(HISTORY_LOG_STORE_NAME)) {
        db.createObjectStore(HISTORY_LOG_STORE_NAME, { keyPath: ['sessionId', 'id'] })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}
