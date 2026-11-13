import type { HistoryPersistPort } from '@einfach/core'
import { newId } from '../runtime/newId'
import {
  validateHistoryLogBatch,
  type HistoryLogBatch,
  type HistoryLogDriver,
  type HistoryLogOperation,
} from './persistence/historyLogDriver'

const BATCH_TARGET_BYTES = 512 * 1024

export interface HistoryPersistenceCapture {
  readonly head: string | null
  /** Retries unacknowledged batches in order, stopping at this immutable capture. */
  flush(driver: HistoryLogDriver, sessionId: string): Promise<void>
}

export interface HistoryPersistence {
  port: HistoryPersistPort
  capture(): HistoryPersistenceCapture
  restore(head: string | null): void
}

/** Collects Einfach's incremental callbacks without subscribing to or copying the history stack. */
export function createHistoryPersistence(): HistoryPersistence {
  let head: string | null = null
  let operations: HistoryLogOperation[] = []
  let bytes = 0
  let sequence = 0
  let failure: unknown
  let pending: { sequence: number; batch: HistoryLogBatch }[] = []
  let tail = Promise.resolve()

  function seal(): void {
    if (!operations.length) return
    const batch = validateHistoryLogBatch({ version: 1, id: newId(), parent: head, operations })
    pending.push({ sequence: ++sequence, batch })
    head = batch.id
    operations = []
    bytes = 0
  }

  function record(operation: HistoryLogOperation): void {
    if (failure) return
    try {
      const json = JSON.stringify(operation)
      const size = new TextEncoder().encode(json).byteLength
      if (bytes + size > BATCH_TARGET_BYTES) seal()
      operations.push(JSON.parse(json) as HistoryLogOperation)
      bytes += size
    } catch (error) {
      // Einfach deliberately does not await ports. Keep failures visible to the durability fence.
      failure = error
    }
  }

  return {
    port: {
      append: (entry) => record({ type: 'append', entry }),
      dropOldest: (count) => record({ type: 'dropOldest', count }),
      dropAfter: (cursor) => record({ type: 'dropAfter', cursor }),
      setCursor: (cursor) => record({ type: 'setCursor', cursor }),
      async load() { return null },
    },
    capture() {
      if (failure) throw failure
      seal()
      const cutoff = sequence
      return {
        head,
        flush(driver, sessionId) {
          const write = async () => {
            for (const entry of pending) {
              if (entry.sequence > cutoff) break
              await driver.append(sessionId, entry.batch)
              pending = pending.filter((candidate) => candidate !== entry)
            }
          }
          const result = tail.then(write, write)
          tail = result.catch(() => undefined)
          return result
        },
      }
    },
    restore(restoredHead) {
      if (pending.length || operations.length) throw new Error('Cannot replace an active history journal')
      head = restoredHead
    },
  }
}
