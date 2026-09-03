import type { TraceLogReader, TraceLogSnapshot, TraceEvent, TraceSpan } from '@einfach-agent/core/observability'
import {
  DEFAULT_LOG_DB_NAME,
  EVENTS_STORE_NAME,
  SPANS_STORE_NAME,
  openIndexedDbLogDatabase,
} from './indexedDbLogDatabase'

function getAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve([])
      return
    }
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error(`read ${storeName} failed`))
    tx.onerror = () => reject(tx.error ?? new Error(`transaction ${storeName} failed`))
    tx.onabort = () => reject(tx.error ?? new Error(`transaction ${storeName} aborted`))
  })
}

export function createIndexedDbLogReader(dbName: string = DEFAULT_LOG_DB_NAME): TraceLogReader {
  return {
    source: 'indexeddb',
    async readAll(): Promise<TraceLogSnapshot> {
      const db = await openIndexedDbLogDatabase(dbName)
      try {
        const [spans, events] = await Promise.all([
          getAll<TraceSpan>(db, SPANS_STORE_NAME),
          getAll<TraceEvent>(db, EVENTS_STORE_NAME),
        ])
        return {
          source: 'indexeddb',
          loadedAt: Date.now(),
          spans,
          events,
        }
      } finally {
        db.close()
      }
    },
  }
}
