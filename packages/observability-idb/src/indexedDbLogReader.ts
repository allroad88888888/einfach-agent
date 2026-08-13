import type { TraceLogReader, TraceLogSnapshot } from '@web-agent/core/observability/logReader'
import type { TraceEvent, TraceSpan } from '@web-agent/core/observability/types'

const DEFAULT_DB_NAME = 'web-agent-observability'
const SPANS_STORE = 'trace_spans'
const EVENTS_STORE = 'trace_events'

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SPANS_STORE)) {
        const store = db.createObjectStore(SPANS_STORE, { keyPath: 'id' })
        store.createIndex('traceId', 'traceId')
        store.createIndex('startedAt', 'startedAt')
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const store = db.createObjectStore(EVENTS_STORE, { keyPath: 'id' })
        store.createIndex('traceId', 'traceId')
        store.createIndex('timestamp', 'timestamp')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}

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

export function createIndexedDbLogReader(dbName: string = DEFAULT_DB_NAME): TraceLogReader {
  return {
    source: 'indexeddb',
    async readAll(): Promise<TraceLogSnapshot> {
      const db = await openDb(dbName)
      try {
        const [spans, events] = await Promise.all([
          getAll<TraceSpan>(db, SPANS_STORE),
          getAll<TraceEvent>(db, EVENTS_STORE),
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
