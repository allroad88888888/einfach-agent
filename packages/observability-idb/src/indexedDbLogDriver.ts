// 浏览器 IndexedDB trace driver：本地 best-effort 写 span/event。

import type { TraceDriver, TraceEvent, TraceSpan } from '@einfach-agent/core/observability'
import {
  DEFAULT_LOG_DB_NAME,
  EVENTS_STORE_NAME,
  SPANS_STORE_NAME,
  openIndexedDbLogDatabase,
} from './indexedDbLogDatabase'

async function putRecord(dbName: string, storeName: string, record: TraceSpan | TraceEvent): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openIndexedDbLogDatabase(dbName)
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

export function createIndexedDbLogDriver(dbName: string = DEFAULT_LOG_DB_NAME): TraceDriver {
  return {
    writeSpan(span) {
      return putRecord(dbName, SPANS_STORE_NAME, span)
    },
    writeEvent(event) {
      return putRecord(dbName, EVENTS_STORE_NAME, event)
    },
  }
}
