import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createIndexedDbLogDriver } from './indexedDbLogDriver'
import { createIndexedDbLogReader } from './indexedDbLogReader'
import {
  EVENTS_STORE_NAME,
  LOG_DB_VERSION,
  SPANS_STORE_NAME,
  openIndexedDbLogDatabase,
} from './indexedDbLogDatabase'

describe('observability IndexedDB schema', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('一次升级建立 reader 与 writer 共享的 stores 和 indexes', async () => {
    const db = await openIndexedDbLogDatabase('observability-schema')
    expect(db.version).toBe(LOG_DB_VERSION)
    expect(Array.from(db.objectStoreNames)).toEqual([EVENTS_STORE_NAME, SPANS_STORE_NAME])

    const tx = db.transaction([SPANS_STORE_NAME, EVENTS_STORE_NAME], 'readonly')
    expect(Array.from(tx.objectStore(SPANS_STORE_NAME).indexNames)).toEqual(['startedAt', 'traceId'])
    expect(Array.from(tx.objectStore(EVENTS_STORE_NAME).indexNames)).toEqual(['timestamp', 'traceId'])
    db.close()
  })

  it('writer 写入的两类记录可由独立 reader 完整读回', async () => {
    const dbName = 'observability-reader-writer'
    const driver = createIndexedDbLogDriver(dbName)
    const span = {
      id: 'span-1', traceId: 'trace-1', name: 'request', kind: 'agent' as const,
      status: 'ok' as const, startedAt: 1,
    }
    const event = { id: 'event-1', traceId: 'trace-1', name: 'done', timestamp: 2 }

    await driver.writeSpan(span)
    await driver.writeEvent(event)
    const snapshot = await createIndexedDbLogReader(dbName).readAll()

    expect(snapshot.spans).toEqual([span])
    expect(snapshot.events).toEqual([event])
  })

  it('缺失 IndexedDB 时保留原错误语义', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined, writable: true })
    await expect(openIndexedDbLogDatabase('unavailable')).rejects.toThrow('IndexedDB unavailable')
  })
})
