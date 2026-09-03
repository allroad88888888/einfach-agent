import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { runIndexedDbTransaction } from './indexedDbTransaction'

const errors = { failed: 'contract transaction failed', aborted: 'contract transaction aborted' }

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('runIndexedDbTransaction', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('在 write transaction 完成后返回 operation 设置的结果', async () => {
    const db = await openDatabase('transaction-complete')
    const result = await runIndexedDbTransaction(db, 'records', 'readwrite', errors, (store, setResult, fail) => {
      const request = store.put('value', 'key')
      request.onsuccess = () => setResult('saved')
      request.onerror = () => fail(request.error)
    })

    expect(result).toBe('saved')
    db.close()
  })

  it('operation 主动失败或同步抛错时保留原始错误', async () => {
    const db = await openDatabase('transaction-operation-errors')
    const requestFailure = new Error('request failed')
    await expect(runIndexedDbTransaction(db, 'records', 'readwrite', errors, (_store, _set, fail) => {
      fail(requestFailure)
    })).rejects.toBe(requestFailure)

    const thrown = new Error('operation threw')
    await expect(runIndexedDbTransaction(db, 'records', 'readwrite', errors, () => {
      throw thrown
    })).rejects.toBe(thrown)
    db.close()
  })

  it('外部 abort 没有具体错误时使用调用域提供的错误文案', async () => {
    const db = await openDatabase('transaction-abort-message')
    await expect(runIndexedDbTransaction(db, 'records', 'readwrite', errors, (store) => {
      store.transaction.abort()
    })).rejects.toThrow(errors.aborted)
    db.close()
  })
})
