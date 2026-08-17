// IndexedDB 的会话事务日志 driver。
// ---------------------------------------------------------------------------
// 每个 session 一条、整份覆盖。比恢复 driver 简单得多，因为日志**不是真相**：
// 它靠 `generation` 与恢复快照配对，配不上就被读回侧整份丢弃（见 core 的 historyLogDriver.ts）。
// 所以这里没有 generation 比较、没有 tombstone，也不需要「先读后条件写」的事务。
//
// 读回时不校验条目形状：einfach 的 `hydrate()` 自己会逐条浅校验、非法整条丢弃。
// 这里只负责「取出来的东西长得像一份日志」，剩下的交给它。

import type { HistoryLogDriver, PersistedHistoryLog } from '@web-agent/core/state/persistence'
import {
  DEFAULT_HISTORY_DB_NAME,
  HISTORY_LOG_STORE_NAME,
  openIndexedDbHistoryDatabase,
} from './indexedDbDatabase'

interface HistoryLogRecord extends PersistedHistoryLog {
  sessionId: string
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('History log sessionId must not be empty')
}

/** 取出来的记录长得像一份日志吗。不像就当没有 —— 撤销不可用好过拿坏数据改状态。 */
function decodeStoredLog(value: unknown, sessionId: string): PersistedHistoryLog | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.sessionId !== sessionId) return undefined
  if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation)) return undefined
  if (!Array.isArray(record.entries)) return undefined
  if (typeof record.cursor !== 'number' || !Number.isSafeInteger(record.cursor)) return undefined
  return {
    generation: record.generation,
    entries: record.entries as PersistedHistoryLog['entries'],
    cursor: record.cursor,
  }
}

function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, setResult: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_LOG_STORE_NAME, mode)
    let result: T | undefined
    let failure: unknown
    const fail = (error: unknown) => {
      failure = error
      try {
        transaction.abort()
      } catch {
        // 已完成或已中止时，transaction 的事件仍会统一 reject。
      }
    }
    transaction.oncomplete = () => resolve(result as T)
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('IndexedDB history log transaction failed'))
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('IndexedDB history log transaction aborted'))
    try {
      operation(transaction.objectStore(HISTORY_LOG_STORE_NAME), (value) => { result = value }, fail)
    } catch (error) {
      fail(error)
    }
  })
}

export function createIndexedDbHistoryLogDriver(
  dbName: string = DEFAULT_HISTORY_DB_NAME,
): HistoryLogDriver {
  return {
    async load(sessionId) {
      assertSessionId(sessionId)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        return await runTransaction<PersistedHistoryLog | undefined>(db, 'readonly', (store, setResult, fail) => {
          const request = store.get(sessionId)
          request.onsuccess = () => setResult(decodeStoredLog(request.result, sessionId))
          request.onerror = () => fail(request.error ?? new Error('IndexedDB history log read failed'))
        })
      } finally {
        db.close()
      }
    },

    async save(sessionId, log) {
      assertSessionId(sessionId)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        await runTransaction<void>(db, 'readwrite', (store, setResult, fail) => {
          const write = store.put({ sessionId, ...log } satisfies HistoryLogRecord)
          write.onsuccess = () => setResult(undefined)
          write.onerror = () => fail(write.error ?? new Error('IndexedDB history log write failed'))
        })
      } finally {
        db.close()
      }
    },

    async deleteSession(sessionId) {
      assertSessionId(sessionId)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        await runTransaction<void>(db, 'readwrite', (store, setResult, fail) => {
          const write = store.delete(sessionId)
          write.onsuccess = () => setResult(undefined)
          write.onerror = () => fail(write.error ?? new Error('IndexedDB history log delete failed'))
        })
      } finally {
        db.close()
      }
    },
  }
}
