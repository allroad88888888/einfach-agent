// D-3 · 启动 hydrate 的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// 覆盖 §4 D-3 / DK1 / DK2 三条：
//   · 有持久化会话 → 回填 rootStore（sessionsAtom + 按 updatedAt 最新的 activeSessionId）
//     + 各会话 store（checkpointsAtom / itemsAtom=最新轮 items / currentTurnIndexAtom=最新轮），返回 true；
//   · 空 sessions → 返回 false 且 rootStore 不变（让 main.tsx 去种子）；
//   · loadSessions 抛错 → 返回 false 且不抛（容错，DK2）。
// 用内存 HistoryDriver + fake sessions（{ loadSessions }），不引真实 IndexedDB。

import { afterEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom } from '../sessionAtoms'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import { hydrate } from './hydrate'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
})

// 两个会话：s2 的 updatedAt 更大（更新更晚），hydrate 后应作为 active。
const s1: SessionMeta = {
  id: 's1',
  title: 'A',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 100,
}
const s2: SessionMeta = {
  id: 's2',
  title: 'B',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 200,
}

// 造一轮 checkpoint：turnIndex + 一条 user item（内容含标记便于断言）。
function cp(turnIndex: number, content: string): Checkpoint {
  return {
    turnIndex,
    label: `t${turnIndex}`,
    createdAt: turnIndex,
    items: [{ id: `${content}-${turnIndex}`, createdAt: turnIndex, item: { role: 'user', content } }],
  }
}

describe('hydrate', () => {
  it('有持久化会话 → 回填 rootStore + 各会话 store，返回 true', async () => {
    const history = createMemoryHistoryDriver()
    // s1 两轮、s2 三轮。
    await history.saveCheckpoint('s1', cp(0, 's1a'))
    await history.saveCheckpoint('s1', cp(1, 's1b'))
    await history.saveCheckpoint('s2', cp(0, 's2a'))
    await history.saveCheckpoint('s2', cp(1, 's2b'))
    await history.saveCheckpoint('s2', cp(2, 's2c'))

    const sessions = { loadSessions: async () => [s1, s2] }
    const result = await hydrate({ sessions, history })

    expect(result).toBe(true)
    // 会话列表登记表：两个会话齐全。
    expect(rootStore.getter(sessionsAtom)).toEqual({ s1, s2 })
    // active = updatedAt 最新（s2, 200 > 100）。
    expect(rootStore.getter(activeSessionIdAtom)).toBe('s2')

    // s1：checkpoints 恢复两轮、currentTurnIndex=1、items=最新轮 items。
    const store1 = getSessionStore('s1').store
    expect(store1.getter(checkpointsAtom)).toHaveLength(2)
    expect(store1.getter(currentTurnIndexAtom)).toBe(1)
    expect(store1.getter(itemsAtom)).toEqual(cp(1, 's1b').items)

    // s2：checkpoints 恢复三轮、currentTurnIndex=2、items=最新轮 items。
    const store2 = getSessionStore('s2').store
    expect(store2.getter(checkpointsAtom)).toHaveLength(3)
    expect(store2.getter(currentTurnIndexAtom)).toBe(2)
    expect(store2.getter(itemsAtom)).toEqual(cp(2, 's2c').items)
  })

  it('空 sessions → 返回 false 且 rootStore 不变', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [] as SessionMeta[] }

    const result = await hydrate({ sessions, history })

    expect(result).toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })

  it('loadSessions 抛错 → 返回 false 且不抛', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = {
      loadSessions: async (): Promise<SessionMeta[]> => {
        throw new Error('boom')
      },
    }

    // resolves.toBe(false) 同时断言「不抛」+「返回 false」。
    await expect(hydrate({ sessions, history })).resolves.toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
  })
})
