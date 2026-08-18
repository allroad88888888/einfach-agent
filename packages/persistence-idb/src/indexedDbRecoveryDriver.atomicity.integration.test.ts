// IndexedDB recovery snapshot 的提交原子性与升级兼容性。

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RecoverySnapshotV1 } from '@web-agent/core/state/persistence'
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
      pendingArtifacts: [],
      executionGraph: { version: 1, nodes: {}, order: [] },
      subagentContinuations: [],
    },
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

})
