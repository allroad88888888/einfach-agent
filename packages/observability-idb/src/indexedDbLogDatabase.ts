// Observability IndexedDB 的数据库名、版本、store schema 与打开流程。

export const DEFAULT_LOG_DB_NAME = 'web-agent-observability'
export const LOG_DB_VERSION = 1
export const SPANS_STORE_NAME = 'trace_spans'
export const EVENTS_STORE_NAME = 'trace_events'

/** 打开或升级 observability 数据库，使 reader 与 writer 消费同一份 schema。 */
export function openIndexedDbLogDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, LOG_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SPANS_STORE_NAME)) {
        const store = db.createObjectStore(SPANS_STORE_NAME, { keyPath: 'id' })
        store.createIndex('traceId', 'traceId')
        store.createIndex('startedAt', 'startedAt')
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE_NAME)) {
        const store = db.createObjectStore(EVENTS_STORE_NAME, { keyPath: 'id' })
        store.createIndex('traceId', 'traceId')
        store.createIndex('timestamp', 'timestamp')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}
