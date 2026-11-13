import {
  checkHistoryLogAppend, replayHistoryLog, validateHistoryLogBatch,
  type HistoryLogBatch, type HistoryLogDriver,
} from '@einfach-agent/core/state/persistence'
import { DEFAULT_HISTORY_DB_NAME, HISTORY_LOG_STORE_NAME, openIndexedDbHistoryDatabase } from './indexedDbDatabase'
import { runIndexedDbTransaction } from './indexedDbTransaction'

const errors = { failed: 'History journal transaction failed', aborted: 'History journal transaction aborted' }

/** Browser-only provider: one immutable batch per record, never a whole-ledger overwrite. */
export function createIndexedDbHistoryLogDriver(dbName = DEFAULT_HISTORY_DB_NAME): HistoryLogDriver {
  return {
    async append(sessionId, candidate) {
      if (!sessionId) throw new Error('History journal sessionId must not be empty')
      const batch = validateHistoryLogBatch(candidate)
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        await runIndexedDbTransaction<void>(db, HISTORY_LOG_STORE_NAME, 'readwrite', errors, (store, done, fail) => {
          const existing = store.get([sessionId, batch.id])
          existing.onsuccess = () => {
            const records = new Map<string, HistoryLogBatch>()
            if (existing.result) records.set(batch.id, existing.result.batch)
            const save = () => {
              try {
                if (checkHistoryLogAppend(records, batch) === 'duplicate') { done(undefined); return }
                const request = store.add({ sessionId, id: batch.id, batch })
                request.onsuccess = () => done(undefined)
                request.onerror = () => fail(request.error)
              } catch (error) { fail(error) }
            }
            if (batch.parent === null || existing.result) { save(); return }
            const parent = store.get([sessionId, batch.parent])
            parent.onsuccess = () => {
              if (parent.result) records.set(batch.parent!, parent.result.batch)
              save()
            }
            parent.onerror = () => fail(parent.error)
          }
          existing.onerror = () => fail(existing.error)
        })
      } finally { db.close() }
    },
    async load(sessionId, head) {
      if (!sessionId) throw new Error('History journal sessionId must not be empty')
      if (head === null) return { entries: [], cursor: 0 }
      const db = await openIndexedDbHistoryDatabase(dbName)
      try {
        const records = await runIndexedDbTransaction<Map<string, HistoryLogBatch>>(
          db, HISTORY_LOG_STORE_NAME, 'readonly', errors, (store, done, fail) => {
            const chain = new Map<string, HistoryLogBatch>()
            const read = (id: string) => {
              const request = store.get([sessionId, id])
              request.onerror = () => fail(request.error)
              request.onsuccess = () => {
                try {
                  if (!request.result || chain.has(id)) throw new Error('Broken history journal chain')
                  const batch = validateHistoryLogBatch(request.result.batch)
                  if (batch.id !== id) throw new Error('History journal identity mismatch')
                  chain.set(id, batch)
                  if (batch.parent === null) done(chain)
                  else read(batch.parent)
                } catch (error) { fail(error) }
              }
            }
            read(head)
          },
        )
        return replayHistoryLog(records, head)
      } finally { db.close() }
    },
  }
}
