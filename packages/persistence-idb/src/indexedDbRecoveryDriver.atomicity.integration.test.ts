// IndexedDB recovery snapshot 的提交原子性与升级兼容性。

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Checkpoint, RecoverySnapshotV1 } from '@web-agent/core/state/persistence'
import { createIndexedDbHistoryDriver } from './indexedDbDriver'
import { createIndexedDbRecoveryDriver } from './indexedDbRecoveryDriver'

function recoverySnapshot(generation: number, sessionId = 'session-1'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId,
    capturedAt: generation,
    generation,
    commitMarker: 'complete',
    session: {
      id: sessionId,
      title: 'Interrupted task',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 0,
      updatedAt: 0,
    },
    values: {
      conversation: { items: [], contextCheckpoint: null },
      plan: { current: null, stageCheckpoints: [] },
      run: null,
      queuedUserMessages: [],
      pendingQuestionAnswers: {},
      executionGraph: { version: 1, nodes: {}, order: [] },
      subagentContinuations: [],
    },
  }
}

const legacyCheckpoint: Checkpoint = {
  turnIndex: 3,
  label: 'checkpoint before upgrade',
  createdAt: 12,
  items: [{ id: 'item-1', createdAt: 12, item: { role: 'user', content: 'preserve me' } }],
}

async function createVersionOneHistoryDatabase(dbName: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('checkpoints', { keyPath: ['sessionId', 'turnIndex'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('checkpoints', 'readwrite')
      transaction.objectStore('checkpoints').put({
        sessionId: 'legacy-session',
        turnIndex: legacyCheckpoint.turnIndex,
        checkpoint: legacyCheckpoint,
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

describe('IndexedDB recovery driver atomicity', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('makes a completed write visible to a fresh recovery driver', async () => {
    const dbName = 'recovery-completed-visibility'
    const writer = createIndexedDbRecoveryDriver(dbName)
    const reader = createIndexedDbRecoveryDriver(dbName)
    const saved = recoverySnapshot(1)

    expect(await reader.loadLatest(saved.sessionId)).toBeUndefined()
    await expect(writer.saveLatest(saved.sessionId, saved)).resolves.toEqual({ status: 'saved', generation: 1 })
    await expect(reader.loadLatest(saved.sessionId)).resolves.toEqual(saved)
    await expect(reader.listLatest()).resolves.toEqual([saved])
  })

  it('does not let a stale writer overwrite the newest committed generation', async () => {
    const dbName = 'recovery-stale-writer'
    const latestWriter = createIndexedDbRecoveryDriver(dbName)
    const lateWriter = createIndexedDbRecoveryDriver(dbName)
    const newest = recoverySnapshot(8)

    await latestWriter.saveLatest(newest.sessionId, newest)
    await expect(lateWriter.saveLatest(newest.sessionId, recoverySnapshot(7))).resolves.toEqual({
      status: 'stale',
      currentGeneration: 8,
    })
    await expect(createIndexedDbRecoveryDriver(dbName).loadLatest(newest.sessionId)).resolves.toEqual(newest)
  })

  it('keeps a deletion tombstone as a fence against a late recovery save', async () => {
    const dbName = 'recovery-tombstone-fence'
    const creator = createIndexedDbRecoveryDriver(dbName)
    const lateWriter = createIndexedDbRecoveryDriver(dbName)
    const deleted = recoverySnapshot(2)

    await creator.saveLatest(deleted.sessionId, deleted)
    await creator.deleteSession(deleted.sessionId)
    await expect(lateWriter.saveLatest(deleted.sessionId, recoverySnapshot(99))).resolves.toEqual({
      status: 'tombstoned',
    })
    await expect(lateWriter.loadLatest(deleted.sessionId)).resolves.toBeUndefined()
    await expect(lateWriter.listLatest()).resolves.toEqual([])
  })

  it('upgrades a v1 history database without losing checkpoints and exposes v2 recovery records', async () => {
    const dbName = 'history-v1-to-v2-recovery'
    await createVersionOneHistoryDatabase(dbName)

    const recovery = createIndexedDbRecoveryDriver(dbName)
    const snapshot = recoverySnapshot(1, 'recovered-session')
    await recovery.saveLatest(snapshot.sessionId, snapshot)

    await expect(createIndexedDbHistoryDriver(dbName).loadCheckpoint('legacy-session', 3))
      .resolves.toEqual(legacyCheckpoint)
    await expect(createIndexedDbRecoveryDriver(dbName).loadLatest(snapshot.sessionId)).resolves.toEqual(snapshot)
  })
})
