import { describe, it, expect } from 'vitest'
import type { HistoryDriver } from './historyDriver'
import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'

// 纯接口文件无运行时逻辑：靠「实现前 import 缺失（TS2307）→ 补上接口」制造红→绿。
// 用 inline mock 证明「满足接口的对象可调用」，用 @ts-expect-error 证明「缺方法不满足接口」。
describe('HistoryDriver 接口', () => {
  // 一个满足接口的最小 inline mock：各方法都返回 Promise.resolve(...)。
  const sampleCheckpoint: Checkpoint = {
    turnIndex: 0,
    label: 'first turn',
    createdAt: 0,
    items: [{ id: 'i1', createdAt: 0, item: { role: 'user', content: 'hi' } }],
  }
  const sampleMeta: CheckpointMeta = { turnIndex: 0, label: 'first turn', createdAt: 0 }

  it('满足接口的对象每个方法都可 await 调用', async () => {
    const d: HistoryDriver = {
      listCheckpoints: (_sessionId: string) => Promise.resolve([sampleMeta]),
      loadCheckpoint: (_sessionId: string, _turnIndex: number) =>
        Promise.resolve(sampleCheckpoint),
      saveCheckpoint: (_sessionId: string, _checkpoint: Checkpoint) => Promise.resolve(),
      truncateAfter: (_sessionId: string, _turnIndex: number) => Promise.resolve(),
      deleteSession: (_sessionId: string) => Promise.resolve(),
    }

    const metas = await d.listCheckpoints('s')
    expect(Array.isArray(metas)).toBe(true)
    expect(metas[0]?.turnIndex).toBe(0)

    const cp = await d.loadCheckpoint('s', 0)
    expect(cp?.items).toHaveLength(1)

    await expect(d.saveCheckpoint('s', sampleCheckpoint)).resolves.toBeUndefined()
    await expect(d.truncateAfter('s', 0)).resolves.toBeUndefined()
    await expect(d.deleteSession('s')).resolves.toBeUndefined()
  })

  it('越界 loadCheckpoint 允许返回 undefined', async () => {
    const d: HistoryDriver = {
      listCheckpoints: () => Promise.resolve([]),
      loadCheckpoint: () => Promise.resolve(undefined),
      saveCheckpoint: () => Promise.resolve(),
      truncateAfter: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(),
    }

    await expect(d.loadCheckpoint('s', 99)).resolves.toBeUndefined()
  })

  it('缺方法的对象不满足 HistoryDriver（类型断言）', () => {
    // @ts-expect-error 缺 deleteSession，不满足 HistoryDriver
    const bad: HistoryDriver = {
      listCheckpoints: () => Promise.resolve([]),
      loadCheckpoint: () => Promise.resolve(undefined),
      saveCheckpoint: () => Promise.resolve(),
      truncateAfter: () => Promise.resolve(),
    }
    expect(bad).toBeDefined()
  })
})
