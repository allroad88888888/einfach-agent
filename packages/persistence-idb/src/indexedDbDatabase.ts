// web-agent-history 的 IndexedDB 架构版本与打开逻辑。

export const DEFAULT_HISTORY_DB_NAME = 'web-agent-history'
export const HISTORY_DB_VERSION = 2
export const CHECKPOINT_STORE_NAME = 'checkpoints'
export const RECOVERY_SNAPSHOT_STORE_NAME = 'recoverySnapshots'

/** v1 保留 checkpoint store；v2 在同一个数据库内加入单 session 的恢复记录 store。 */
export function openIndexedDbHistoryDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, HISTORY_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE_NAME)) {
        db.createObjectStore(CHECKPOINT_STORE_NAME, { keyPath: ['sessionId', 'turnIndex'] })
      }
      if (!db.objectStoreNames.contains(RECOVERY_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(RECOVERY_SNAPSHOT_STORE_NAME, { keyPath: 'sessionId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}
