// P8 · 内存 driver 实现的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// 覆盖 §3「P8」四条：save→list→load round-trip；truncateAfter 删 > N；
// deleteSession 清空；loadCheckpoint 越界 undefined。全部方法均为 async（await）。
// 纯内存 Map 占位实现，不引 tauri/sql/idb（C1）。

import { describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'

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

describe('createMemoryHistoryDriver', () => {
  it('save → list 返回去 items 的轻量 meta 数组', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    const metas = await d.listCheckpoints('s1')
    expect(metas).toHaveLength(2)
    for (const m of metas) {
      expect(m).not.toHaveProperty('items')
    }
    expect(metas[0]).toEqual({ turnIndex: 0, label: 'a', createdAt: 0 })
    expect(metas[1]).toEqual({ turnIndex: 1, label: 'b', createdAt: 1 })
  })

  it('未知会话 list 返回 []', async () => {
    const d = createMemoryHistoryDriver()
    expect(await d.listCheckpoints('nope')).toEqual([])
  })

  it('相同 turnIndex 再次保存时覆盖工作快照', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    const updated = { ...cp0, label: 'done', items: cp1.items }
    await d.saveCheckpoint('s1', updated)

    expect(await d.listCheckpoints('s1')).toEqual([
      { turnIndex: 0, label: 'done', createdAt: cp0.createdAt },
    ])
    expect(await d.loadCheckpoint('s1', 0)).toEqual(updated)
  })

  it('loadCheckpoint 命中返回含 items 的完整 cp；越界返回 undefined', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    expect(await d.loadCheckpoint('s1', 0)).toEqual(cp0)
    expect(await d.loadCheckpoint('s1', 99)).toBeUndefined()
    expect(await d.loadCheckpoint('nope', 0)).toBeUndefined()
  })

  it('truncateAfter 只保留 turnIndex <= N 的 checkpoint', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    await d.truncateAfter('s1', 0)
    const metas = await d.listCheckpoints('s1')
    expect(metas).toHaveLength(1)
    expect(metas[0].turnIndex).toBe(0)
  })

  it('deleteSession 后该会话 list 为 []', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s1', cp1)

    await d.deleteSession('s1')
    expect(await d.listCheckpoints('s1')).toEqual([])
  })

  it('会话之间互相隔离', async () => {
    const d = createMemoryHistoryDriver()
    await d.saveCheckpoint('s1', cp0)
    await d.saveCheckpoint('s2', cp1)

    expect(await d.listCheckpoints('s1')).toHaveLength(1)
    expect(await d.listCheckpoints('s2')).toHaveLength(1)
    await d.deleteSession('s1')
    expect(await d.listCheckpoints('s1')).toEqual([])
    expect(await d.listCheckpoints('s2')).toHaveLength(1)
  })
})
