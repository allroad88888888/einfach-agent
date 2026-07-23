import { afterEach, describe, expect, it } from 'vitest'
import { getSessionStore, resetSessionStores } from './sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom } from './sessionAtoms'
import { rootStore, sessionsAtom, resetRootStore } from './rootStore'
import type { ConversationItem, SessionMeta } from './core.type'
import { commitCheckpoint, jumpToCheckpoint } from './checkpointWriters'
import { createCoreInstance } from '../runtime/core/coreInstance'

// checkpoint 写入 / 截断式回退（P6，C2）：
//   commit —— 把当前 store 的 items 快照进 checkpointsAtom；
//   jump   —— 恢复某轮 items + 截断其后的 checkpoint（git reset --hard 语义）。
// ghost guard（C7）：会话未在 rootStore.sessionsAtom 登记 → 写入器必须 no-op，
//   所以下面每个「正常路径」用例都先 seed 's1'，否则加 guard 后会全部 no-op。
// 每个用例后清空全部 session store + 复位 rootStore，隔离状态。
afterEach(() => {
  resetSessionStores()
  resetRootStore()
})

// 登记一个 's1' 会话（写入器的 ghost guard 就查这张登记表）。
const s1Meta: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}
function seedS1(): void {
  rootStore.setter(sessionsAtom, { s1: s1Meta })
}

const item1: ConversationItem = {
  id: 'i1',
  createdAt: 0,
  item: { role: 'user', content: 'hi' },
}
const item2: ConversationItem = {
  id: 'i2',
  createdAt: 1,
  item: { role: 'user', content: 'yo' },
}

describe('checkpointWriters', () => {
  it('commitCheckpoint 追加快照并推进 currentTurnIndex', () => {
    seedS1()
    const store = getSessionStore('s1').store

    // 轮1：items = [item1]
    const items1: ConversationItem[] = [item1]
    store.setter(itemsAtom, items1)
    commitCheckpoint('s1', '轮1')

    const afterFirst = store.getter(checkpointsAtom)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].turnIndex).toBe(0)
    expect(afterFirst[0].label).toBe('轮1')
    // 快照持有的正是提交当时那份 items（引用一致）
    expect(afterFirst[0].items).toBe(items1)
    expect(afterFirst[0].items).toEqual([item1])
    expect(store.getter(currentTurnIndexAtom)).toBe(0)

    // 轮2：items 不可变替换为 [item1, item2]
    const items2: ConversationItem[] = [item1, item2]
    store.setter(itemsAtom, items2)
    commitCheckpoint('s1', '轮2')

    const afterSecond = store.getter(checkpointsAtom)
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond[1].turnIndex).toBe(1)
    expect(store.getter(currentTurnIndexAtom)).toBe(1)
    // C4：早先的快照不受后续变更影响（仍是 [item1] 那份引用）
    expect(afterSecond[0].items).toBe(items1)
    expect(afterSecond[0].items).toEqual([item1])
  })

  it('jumpToCheckpoint 恢复 items 并截断其后 checkpoint（C2）', () => {
    seedS1()
    const store = getSessionStore('s1').store

    const items1: ConversationItem[] = [item1]
    store.setter(itemsAtom, items1)
    commitCheckpoint('s1', '轮1')

    const items2: ConversationItem[] = [item1, item2]
    store.setter(itemsAtom, items2)
    commitCheckpoint('s1', '轮2')

    // 跳回第 0 轮
    const cp0Items = store.getter(checkpointsAtom)[0].items
    jumpToCheckpoint('s1', 0)

    // items 恢复成第 0 轮的快照
    expect(store.getter(itemsAtom)).toBe(cp0Items)
    expect(store.getter(itemsAtom)).toEqual([item1])
    // 列表被截断到 turnIndex + 1 = 1（丢弃第 0 轮之后的轮）
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    // 游标回到第 0 轮
    expect(store.getter(currentTurnIndexAtom)).toBe(0)
  })

  it('恢复后 itemsAtom 是新引用（不可变替换，C4）', () => {
    seedS1()
    const store = getSessionStore('s1').store

    store.setter(itemsAtom, [item1])
    commitCheckpoint('s1', '轮1')

    const items2: ConversationItem[] = [item1, item2]
    store.setter(itemsAtom, items2)
    commitCheckpoint('s1', '轮2')

    const beforeJump = store.getter(itemsAtom)
    jumpToCheckpoint('s1', 0)
    const afterJump = store.getter(itemsAtom)

    // 恢复是「整体替换」而非原地改动 —— 与回跳前是不同的数组引用
    expect(afterJump).not.toBe(beforeJump)
    expect(afterJump).not.toBe(items2)
  })

  it('jumpToCheckpoint 越界（turnIndex 不存在）→ no-op，各 atom 无变化', () => {
    seedS1()
    const store = getSessionStore('s1').store

    const items2: ConversationItem[] = [item1, item2]
    store.setter(itemsAtom, [item1])
    commitCheckpoint('s1', '轮1')
    store.setter(itemsAtom, items2)
    commitCheckpoint('s1', '轮2')

    const itemsBefore = store.getter(itemsAtom)
    const checkpointsBefore = store.getter(checkpointsAtom)
    const turnIndexBefore = store.getter(currentTurnIndexAtom)

    jumpToCheckpoint('s1', 99)

    // 越界应完全不改动任何 atom（引用都一致）
    expect(store.getter(itemsAtom)).toBe(itemsBefore)
    expect(store.getter(checkpointsAtom)).toBe(checkpointsBefore)
    expect(store.getter(checkpointsAtom)).toHaveLength(2)
    expect(store.getter(currentTurnIndexAtom)).toBe(turnIndexBefore)
  })

  it('未登记会话（rootStore 无）→ commit/jump 均 no-op，不复活幽灵会话（C7）', () => {
    // 故意不 seed：'sX' 未在 rootStore.sessionsAtom 登记 —— 是幽灵会话。
    // commit 必须被 ghost guard 拦下，不往 'sX' 的 store 写任何快照。
    commitCheckpoint('sX', 'x')
    expect(getSessionStore('sX').store.getter(checkpointsAtom)).toEqual([])
    expect(getSessionStore('sX').store.getter(currentTurnIndexAtom)).toBe(-1)

    // jump 同样 no-op —— 不抛异常、不改任何 atom。
    expect(() => jumpToCheckpoint('sX', 0)).not.toThrow()
    expect(getSessionStore('sX').store.getter(checkpointsAtom)).toEqual([])
    expect(getSessionStore('sX').store.getter(itemsAtom)).toEqual([])
  })
})

// 【实例化 · 第 2 期穿线】commitCheckpoint / jumpToCheckpoint 都加了默认参数 core（默认 defaultCore）。
// 下面验证传入一个独立 core（createCoreInstance() 造的）时，写入只落在该 core 自己的 store，
// 不经过、也不污染 defaultCore（第 3 期隔离雏形）——同时反证 core 真的被用上了，
// 而不是默默退回模块全局。注意：这里刻意不 seedS1()（那只登记 defaultCore 的 rootStore），
// 独立 core 的 ghost guard 认的是它自己的 rootStore，所以要单独在 core.rootStore 登记 's1'。
describe('checkpointWriters — core 穿线隔离（第 2 期）', () => {
  it('commitCheckpoint 传入独立 core：快照只写进该 core 的 store，defaultCore 同 id 会话保持空白', () => {
    const core = createCoreInstance()
    core.rootStore.setter(sessionsAtom, { s1: s1Meta })

    const isolatedStore = core.getSessionStore('s1').store
    isolatedStore.setter(itemsAtom, [item1])
    commitCheckpoint('s1', '轮1', core)

    // 独立 core 一侧：checkpoint 真的落地了。
    expect(isolatedStore.getter(checkpointsAtom)).toHaveLength(1)
    expect(isolatedStore.getter(checkpointsAtom)[0].items).toEqual([item1])
    expect(isolatedStore.getter(currentTurnIndexAtom)).toBe(0)

    // defaultCore 一侧：本用例没 seedS1()，'s1' 在 defaultCore 的登记表里本就不存在；
    // 即便按 id 撞上同名的 session store，也不该有刚才那条 checkpoint —— 证明两个 core 互不污染。
    expect(rootStore.getter(sessionsAtom).s1).toBeUndefined()
    expect(getSessionStore('s1').store.getter(checkpointsAtom)).toEqual([])
    expect(getSessionStore('s1').store.getter(itemsAtom)).toEqual([])
  })

  it('jumpToCheckpoint 传入独立 core：回退只操作该 core 的 store，defaultCore 同 id 会话不受影响', () => {
    const core = createCoreInstance()
    core.rootStore.setter(sessionsAtom, { s1: s1Meta })
    const isolatedStore = core.getSessionStore('s1').store

    isolatedStore.setter(itemsAtom, [item1])
    commitCheckpoint('s1', '轮1', core)
    isolatedStore.setter(itemsAtom, [item1, item2])
    commitCheckpoint('s1', '轮2', core)

    jumpToCheckpoint('s1', 0, core)

    // 独立 core 一侧：恢复到第 0 轮，并截断掉第 1 轮。
    expect(isolatedStore.getter(itemsAtom)).toEqual([item1])
    expect(isolatedStore.getter(checkpointsAtom)).toHaveLength(1)
    expect(isolatedStore.getter(currentTurnIndexAtom)).toBe(0)

    // defaultCore 一侧：同 id 's1' 的 session store 完全空白，没被这次隔离 core 的操作影响到。
    expect(getSessionStore('s1').store.getter(itemsAtom)).toEqual([])
    expect(getSessionStore('s1').store.getter(checkpointsAtom)).toEqual([])
  })
})
