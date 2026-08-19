// IndexedDB 的单 session 中断恢复 driver。
// ---------------------------------------------------------------------------
// save 在一个 readwrite transaction 内先读 generation 再条件 put，且只在 tx complete 后返回；
// 因此同一 store 的跨 tab 写入被 IDB 串行化。tombstone 保存在同一 key，禁止迟到 writer 复活记录。

import {
  type RecoveryDriver,
  type RecoverySaveResult,
  type RecoverySnapshotV1,
  validateRecoverySnapshot,
} from '@einfach-agent/core/state/persistence'
import {
  DEFAULT_HISTORY_DB_NAME,
  RECOVERY_SNAPSHOT_STORE_NAME,
  openIndexedDbHistoryDatabase,
} from './indexedDbDatabase'

interface RecoveryRecord {
  sessionId: string
  deleted: boolean
  snapshot?: RecoverySnapshotV1
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('Recovery sessionId must not be empty')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeStoredRecord(value: unknown, sessionId: string): RecoveryRecord | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.sessionId !== sessionId) throw new Error('Corrupt IndexedDB recovery record')
  if (value.deleted === true && !('snapshot' in value)) return { sessionId, deleted: true }
  if (value.deleted !== false || !('snapshot' in value)) throw new Error('Corrupt IndexedDB recovery record')
  return { sessionId, deleted: false, snapshot: validateRecoverySnapshot(value.snapshot, sessionId) }
}

function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, setResult: (result: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECOVERY_SNAPSHOT_STORE_NAME, mode)
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
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('IndexedDB recovery transaction failed'))
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('IndexedDB recovery transaction aborted'))
    try {
      operation(transaction.objectStore(RECOVERY_SNAPSHOT_STORE_NAME), (value) => { result = value }, fail)
    } catch (error) {
      fail(error)
    }
  })
}

function requestRecord(
  store: IDBObjectStore,
  sessionId: string,
  setResult: (record: RecoveryRecord | undefined) => void,
  fail: (error: unknown) => void,
): void {
  const request = store.get(sessionId)
  request.onsuccess = () => {
    try {
      setResult(decodeStoredRecord(request.result, sessionId))
    } catch (error) {
      fail(error)
    }
  }
  request.onerror = () => fail(request.error ?? new Error('IndexedDB recovery read failed'))
}

export function createIndexedDbRecoveryDriver(
  dbName: string = DEFAULT_HISTORY_DB_NAME,
): RecoveryDriver {
  return {
    async listLatest() {
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        return await runTransaction(db, 'readonly', (store, setResult, fail) => {
          const request = store.getAll()
          request.onsuccess = () => {
            try {
              const records = (request.result as unknown[]).map((record) => {
                if (!isRecord(record) || typeof record.sessionId !== 'string') {
                  throw new Error('Corrupt IndexedDB recovery record')
                }
                return decodeStoredRecord(record, record.sessionId)
              })
              const snapshots: RecoverySnapshotV1[] = []
              for (const record of records) {
                if (record && !record.deleted && record.snapshot) snapshots.push(record.snapshot)
              }
              setResult(snapshots)
            } catch (error) {
              fail(error)
            }
          }
          request.onerror = () => fail(request.error ?? new Error('IndexedDB recovery list failed'))
        })
      } finally {
        db.close()
      }
    },

    async loadLatest(sessionId) {
      assertSessionId(sessionId)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        return await runTransaction(db, 'readonly', (store, setResult, fail) => {
          requestRecord(store, sessionId, (record) => {
            setResult(record?.deleted ? undefined : record?.snapshot)
          }, fail)
        })
      } finally {
        db.close()
      }
    },

    async saveLatest(sessionId, candidate) {
      assertSessionId(sessionId)
      const snapshot = validateRecoverySnapshot(candidate, sessionId)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        return await runTransaction<RecoverySaveResult>(db, 'readwrite', (store, setResult, fail) => {
          requestRecord(store, sessionId, (current) => {
            if (current?.deleted) {
              setResult({ status: 'tombstoned' })
              return
            }
            if (current?.snapshot && snapshot.generation <= current.snapshot.generation) {
              setResult({ status: 'stale', currentGeneration: current.snapshot.generation })
              return
            }
            const write = store.put({ sessionId, deleted: false, snapshot } satisfies RecoveryRecord)
            write.onerror = () => fail(write.error ?? new Error('IndexedDB recovery write failed'))
            setResult({ status: 'saved', generation: snapshot.generation })
          }, fail)
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
          const write = store.put({ sessionId, deleted: true } satisfies RecoveryRecord)
          write.onsuccess = () => setResult(undefined)
          write.onerror = () => fail(write.error ?? new Error('IndexedDB recovery tombstone failed'))
        })
      } finally {
        db.close()
      }
    },
  }
}
