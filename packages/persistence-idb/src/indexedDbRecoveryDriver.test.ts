import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RecoverySnapshotV1 } from '@web-agent/core/state/persistence'
import { createIndexedDbRecoveryDriver } from './indexedDbRecoveryDriver'
import { HISTORY_DB_VERSION } from './indexedDbDatabase'

function snapshot(generation: number, sessionId = 's1'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId,
    capturedAt: generation,
    generation,
    commitMarker: 'complete',
    session: {
      id: sessionId,
      title: 'Recovery test',
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

function open(dbName: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putRaw(dbName: string, record: unknown): Promise<void> {
  const db = await open(dbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('recoverySnapshots', 'readwrite')
      tx.objectStore('recoverySnapshots').put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function createV1Database(dbName: string): Promise<void> {
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
      const tx = db.transaction('checkpoints', 'readwrite')
      tx.objectStore('checkpoints').put({ sessionId: 'old', turnIndex: 0, checkpoint: { turnIndex: 0 } })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('createIndexedDbRecoveryDriver', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('v1 升级到当前版本时丢弃遗留 checkpoints store，并在 transaction complete 后让新实例看见快照', async () => {
    const dbName = 'v1-upgrade'
    await createV1Database(dbName)
    const first = createIndexedDbRecoveryDriver(dbName)
    const saved = snapshot(2)

    await expect(first.saveLatest('s1', saved)).resolves.toEqual({ status: 'saved', generation: 2 })
    const db = await open(dbName)
    expect(db.version).toBe(HISTORY_DB_VERSION)
    // 轮级 undo 迁往 einfach 事务日志后，checkpoints store 无人读写，升级即删除；
    // 同时 v4 建出事务日志 store（撤销要活过刷新）。
    expect([...db.objectStoreNames].sort()).toEqual(['historyLog', 'recoverySnapshots'])
    db.close()

    const second = createIndexedDbRecoveryDriver(dbName)
    expect(await second.loadLatest('s1')).toEqual(saved)
  })

  it('拒绝不匹配 sessionId 与已损坏的持久化 payload', async () => {
    const dbName = 'validation'
    const driver = createIndexedDbRecoveryDriver(dbName)
    const withFunction = snapshot(1, 'function') as RecoverySnapshotV1 & { extension?: unknown }
    withFunction.extension = () => undefined

    await expect(driver.saveLatest('s2', snapshot(1, 's1'))).rejects.toThrow('sessionId')
    await expect(driver.saveLatest('function', withFunction)).rejects.toThrow('validation')
    expect(await driver.loadLatest('function')).toBeUndefined()
    await driver.saveLatest('s1', snapshot(1))
    await putRaw(dbName, { sessionId: 's1', deleted: false, snapshot: { ...snapshot(1), generation: -1 } })
    await expect(driver.loadLatest('s1')).rejects.toThrow('validation')
  })

  it('CAS 只接受更高 generation', async () => {
    const driver = createIndexedDbRecoveryDriver('cas')
    await driver.saveLatest('s1', snapshot(4))

    await expect(driver.saveLatest('s1', snapshot(4))).resolves.toEqual({
      status: 'stale', currentGeneration: 4,
    })
    await expect(driver.saveLatest('s1', snapshot(5))).resolves.toEqual({ status: 'saved', generation: 5 })
    expect((await driver.loadLatest('s1'))?.generation).toBe(5)
  })

  it('tombstone 对 list/load 隐身，且阻止迟到 writer 复活删除的 session', async () => {
    const driver = createIndexedDbRecoveryDriver('tombstone')
    await driver.saveLatest('s1', snapshot(2))
    await driver.deleteSession('s1')

    expect(await driver.loadLatest('s1')).toBeUndefined()
    expect(await driver.listLatest()).toEqual([])
    await expect(driver.saveLatest('s1', snapshot(99))).resolves.toEqual({ status: 'tombstoned' })
  })
})
