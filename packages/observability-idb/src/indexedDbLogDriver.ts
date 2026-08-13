// 浏览器 IndexedDB trace driver：本地 best-effort 写 span/event。

import type { TraceDriver, TraceEvent, TraceSpan } from '@web-agent/core/observability'

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

async function putRecord(dbName: string, storeName: string, record: TraceSpan | TraceEvent): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openDb(dbName)
  } catch {
    return
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // best-effort。
  } finally {
    db.close()
  }
}

export function createIndexedDbLogDriver(dbName: string = DEFAULT_DB_NAME): TraceDriver {
  return {
    writeSpan(span) {
      return putRecord(dbName, SPANS_STORE, span)
    },
    writeEvent(event) {
      return putRecord(dbName, EVENTS_STORE, event)
    },
  }
}
