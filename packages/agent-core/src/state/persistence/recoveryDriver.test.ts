import { describe, expect, it } from 'vitest'

import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
import {
  createMemoryRecoveryDriver,
  validateRecoverySnapshot,
} from './recoveryDriver'

function snapshot(generation: number, sessionId = 's1'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId,
    capturedAt: generation,
    generation,
    commitMarker: 'complete',
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

describe('RecoveryDriver contract', () => {
  it('JSON 往返验证后保存最新 generation', async () => {
    const driver = createMemoryRecoveryDriver()
    const source = snapshot(2)

    await expect(driver.saveLatest('s1', source)).resolves.toEqual({ status: 'saved', generation: 2 })
    expect(await driver.loadLatest('s1')).toEqual(source)
    expect(await driver.listLatest()).toEqual([source])
  })

  it('拒绝损坏 JSON 与不匹配的 sessionId', async () => {
    const driver = createMemoryRecoveryDriver()
    const invalid = { ...snapshot(1), generation: -1 } as unknown as RecoverySnapshotV1
    const withFunction = snapshot(1) as RecoverySnapshotV1 & { extension?: unknown }
    const circular = snapshot(1) as RecoverySnapshotV1 & { loop?: unknown }
    withFunction.extension = () => undefined
    circular.loop = circular

    expect(() => validateRecoverySnapshot(invalid)).toThrow('validation')
    await expect(driver.saveLatest('s1', withFunction)).rejects.toThrow('validation')
    await expect(driver.saveLatest('s1', circular)).rejects.toThrow('validation')
    expect(await driver.loadLatest('s1')).toBeUndefined()
    expect(await driver.listLatest()).toEqual([])
    await expect(driver.saveLatest('s2', snapshot(1, 's1'))).rejects.toThrow('sessionId')
  })

  it('较旧 generation 不能覆盖较新 generation', async () => {
    const driver = createMemoryRecoveryDriver()
    await driver.saveLatest('s1', snapshot(5))

    await expect(driver.saveLatest('s1', snapshot(5))).resolves.toEqual({
      status: 'stale', currentGeneration: 5,
    })
    await expect(driver.saveLatest('s1', snapshot(6))).resolves.toEqual({ status: 'saved', generation: 6 })
    expect((await driver.loadLatest('s1'))?.generation).toBe(6)
  })

  it('删除写入 tombstone，迟到 writer 不能复活记录', async () => {
    const driver = createMemoryRecoveryDriver()
    await driver.saveLatest('s1', snapshot(2))
    await driver.deleteSession('s1')

    expect(await driver.loadLatest('s1')).toBeUndefined()
    expect(await driver.listLatest()).toEqual([])
    await expect(driver.saveLatest('s1', snapshot(99))).resolves.toEqual({ status: 'tombstoned' })
  })
})
