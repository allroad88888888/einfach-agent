// D-1 · IndexedDB HistoryDriver 实现的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// jsdom 默认没有原生 IndexedDB —— 顶部 `import 'fake-indexeddb/auto'` 把 indexedDB /
//   IDBKeyRange 等注入全局（项目已装 fake-indexeddb@6，见 package.json devDependencies），
//   并在 beforeEach 用 `new IDBFactory()` 重置，保证各用例互相隔离（对齐旧 persistence.test.ts 的做法）。
// 覆盖 §3 D-1 五条：save→list（去 items 的 CheckpointMeta）；loadCheckpoint 命中/越界；
//   truncateAfter 删 > N；deleteSession 清空；会话隔离。全部方法均为 async（await）。

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '@web-agent/core/state/persistence'
import { createIndexedDbHistoryDriver } from './indexedDbDriver'

// cp 样例：两轮（turnIndex 0 / 1），各带一条 user item。
const cp0: Checkpoint = {
  turnIndex: 0,
  label: 'a',
  createdAt: 0,
  items: [{ id: 'i1', createdAt: 0, item: { role: 'user', content: 'hi' } }],
}
const cp1: Checkpoint = {
  turnIndex: 1,
  label: 'b',
  createdAt: 1,
  items: [{ id: 'i2', createdAt: 1, item: { role: 'user', content: 'yo' } }],
}

describe('createIndexedDbHistoryDriver', () => {
  // 每个用例给一个干净的 IndexedDB 实例（丢掉上一个用例落盘的所有库）。
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('save → list 返回按 turnIndex 排序、去 items 的轻量 meta 数组', async () => {
    const d = createIndexedDbHistoryDriver()
    // 故意乱序写入（先 1 后 0），验证 list 是按主键（复合键 [sessionId, turnIndex]）升序返回。
    await d.saveCheckpoint('s1', cp1)
    await d.saveCheckpoint('s1', cp0)

    const metas = await d.listCheckpoints('s1')
    expect(metas).toHaveLength(2)
    for (const m of metas) {
      expect(m).not.toHaveProperty('items')
    }
    expect(metas[0]).toEqual({ turnIndex: 0, label: 'a', createdAt: 0 })
    expect(metas[1]).toEqual({ turnIndex: 1, label: 'b', createdAt: 1 })
  })

  it('未知会话 list 返回 []', async () => {
    const d = createIndexedDbHistoryDriver()
    expect(await d.listCheckpoints('nope')).toEqual([])
  })

  it('loadCheckpoint 命中返回含 items 的完整 cp；越界返回 undefined', async () => {
    const d = createIndexedDbHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    expect(await d.loadCheckpoint('s1', 0)).toEqual(cp0)
    expect(await d.loadCheckpoint('s1', 1)).toEqual(cp1)
    expect(await d.loadCheckpoint('s1', 99)).toBeUndefined()
    expect(await d.loadCheckpoint('nope', 0)).toBeUndefined()
  })

  it('truncateAfter 只保留 turnIndex <= N 的 checkpoint（截断式回退）', async () => {
    const d = createIndexedDbHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    await d.truncateAfter('s1', 0)
    const metas = await d.listCheckpoints('s1')
    expect(metas).toHaveLength(1)
    expect(metas[0].turnIndex).toBe(0)
    // 被截断的一轮确实取不回。
    expect(await d.loadCheckpoint('s1', 1)).toBeUndefined()
  })

  it('deleteSession 后该会话 list 为 []', async () => {
    const d = createIndexedDbHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    await d.deleteSession('s1')
    expect(await d.listCheckpoints('s1')).toEqual([])
  })

  it('会话之间互相隔离', async () => {
    const d = createIndexedDbHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s2', cp1)

    expect(await d.listCheckpoints('s1')).toHaveLength(1)
    expect(await d.listCheckpoints('s2')).toHaveLength(1)

    await d.deleteSession('s1')
    expect(await d.listCheckpoints('s1')).toEqual([])
    expect(await d.listCheckpoints('s2')).toHaveLength(1)
    // 未受影响的会话仍能整段取回。
    expect(await d.loadCheckpoint('s2', 1)).toEqual(cp1)
  })
})
