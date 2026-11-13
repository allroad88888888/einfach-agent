import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HistoryLogBatch } from '@einfach-agent/core/state/persistence'
import { createIndexedDbHistoryLogDriver } from './indexedDbHistoryLogDriver'
import { HISTORY_LOG_STORE_NAME, openIndexedDbHistoryDatabase } from './indexedDbDatabase'

function batch(id: string, parent: string | null, cursor: number): HistoryLogBatch {
  return { version: 1, id, parent, operations: [
    { type: 'append', entry: { txId: id, ops: [{ key: 'slot', before: cursor - 1, after: cursor }] } },
    { type: 'setCursor', cursor },
  ] }
}

beforeEach(() => { globalThis.indexedDB = new IDBFactory() })

describe('IndexedDB incremental history journal', () => {
  it('appends immutable batches and loads only the requested branch', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.append('s', batch('a', null, 1))
    await driver.append('s', batch('b', 'a', 2))
    await driver.append('s', batch('c', 'a', 2))
    expect((await driver.load('s', 'a')).entries).toHaveLength(1)
    expect((await driver.load('s', 'c')).entries.map((entry) => entry.txId)).toEqual(['a', 'c'])
    await driver.append('s', { version: 1, id: 'undo', parent: 'b', operations: [{ type: 'setCursor', cursor: 1 }] })
    expect(await createIndexedDbHistoryLogDriver().load('s', 'undo')).toMatchObject({ cursor: 1, entries: [{}, {}] })
  })

  it('makes acknowledgement-loss retries idempotent and rejects conflicting ids', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.append('s', batch('a', null, 1))
    await driver.append('s', batch('a', null, 1))
    expect((await driver.load('s', 'a')).entries).toHaveLength(1)
    await expect(driver.append('s', batch('a', null, 2))).rejects.toThrow('conflict')
    await expect(driver.append('s', batch('b', 'missing', 2))).rejects.toThrow('parent')
    await expect(driver.load('other', 'a')).rejects.toThrow('chain')
    expect(await driver.load('missing', null)).toEqual({ entries: [], cursor: 0 })
  })

  it('rejects corrupt persisted records without returning a partial ledger', async () => {
    const db = await openIndexedDbHistoryDatabase('web-agent-history')
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HISTORY_LOG_STORE_NAME, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(HISTORY_LOG_STORE_NAME).put({ sessionId: 's', id: 'broken', batch: { version: 99 } })
    })
    db.close()
    await expect(createIndexedDbHistoryLogDriver().load('s', 'broken')).rejects.toThrow('Invalid')
  })
})
