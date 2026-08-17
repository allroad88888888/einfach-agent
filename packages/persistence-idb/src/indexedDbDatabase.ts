// web-agent-history 的 IndexedDB 架构版本与打开逻辑。

export const DEFAULT_HISTORY_DB_NAME = 'web-agent-history'
export const HISTORY_DB_VERSION = 4
export const LEGACY_CHECKPOINT_STORE_NAME = 'checkpoints'
export const RECOVERY_SNAPSHOT_STORE_NAME = 'recoverySnapshots'
export const HISTORY_LOG_STORE_NAME = 'historyLog'

/**
 * v1 只有 checkpoint store；v2 在同一个数据库内加入单 session 的恢复记录 store；
 * v3 随轮级 undo 迁往 einfach 事务日志，把已无人读写的 checkpoint store 一并删掉；
 * v4 加入事务日志 store —— 撤销要活过刷新（与 v1 的 checkpoint store 无关，那是快照式的旧物）。
 */
export function openIndexedDbHistoryDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, HISTORY_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(LEGACY_CHECKPOINT_STORE_NAME)) {
        db.deleteObjectStore(LEGACY_CHECKPOINT_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(RECOVERY_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(RECOVERY_SNAPSHOT_STORE_NAME, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(HISTORY_LOG_STORE_NAME)) {
        db.createObjectStore(HISTORY_LOG_STORE_NAME, { keyPath: 'sessionId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}
