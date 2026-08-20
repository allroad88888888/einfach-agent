// 外部插件的受限状态读写面（F2b）。这里钉四件事：
// 1) 会话侧与跨会话侧各读得到有代表性的值，且读的是 store 里的**当前**值而不是建面时的快照；
// 2) 写入真的入事务日志——整值槽位留下 (key, prev, next)，undo 回到 prev；
// 3) items 走的是增量 op，不是整值记账（op 载荷里只有被追加的那一条，不是整条对话）；
// 4) 三道写入门（ghost/stale run 合并成 isCurrent、AbortSignal）任何一道不过就整体拒绝，
//    且拒绝是返回值，不是抛异常——hook 里抛异常会被熔断计入插件的连续失败。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import type { ContextCheckpoint } from './contextCheckpoint.type'
import type { ConversationItem } from './core.type'
import { createPluginStateAccess, type PluginStateHost } from './pluginStateAccess'
import { activeWorkspaceIdAtom, activeSessionIdAtom, workspacesAtom } from './rootAtoms'
import { contextCheckpointAtom, itemsAtom, runAtom } from './sessionAtoms'
import { createSessionHistory } from './sessionHistory'

function host(overrides: { current?: boolean; aborted?: boolean } = {}) {
  const store = createStore()
  const root = createStore()
  const controller = new AbortController()
  if (overrides.aborted) controller.abort()
  let current = overrides.current ?? true
  const target: PluginStateHost = {
    store,
    root,
    history: createSessionHistory(store),
    signal: controller.signal,
    isCurrent: () => current,
  }
  return { target, store, root, access: createPluginStateAccess(target), stale: () => { current = false } }
}

function item(id: string, content: string): ConversationItem {
  return { id, createdAt: 1, item: { role: 'user', content } }
}

const checkpoint: ContextCheckpoint = {
  schemaVersion: 1,
  summary: '前四十轮的摘要',
  coveredItemIds: ['a'],
  createdAt: 7,
  sourceEstimatedTokens: 1200,
}

describe('createPluginStateAccess —— 读面', () => {
  it('读得到会话 atom 的当前值（不是建面那一刻的快照）', () => {
    const { access, store } = host()
    expect(access.readSession('items')).toEqual([])

    store.setter(itemsAtom, [item('a', '你好')])
    store.setter(runAtom, { runId: 'r1', status: 'running', turnId: 't1' })
    store.setter(contextCheckpointAtom, checkpoint)

    expect(access.readSession('items').map((entry) => entry.id)).toEqual(['a'])
    expect(access.readSession('run')).toEqual({ runId: 'r1', status: 'running' })
    expect(access.readSession('contextCheckpoint')?.summary).toBe('前四十轮的摘要')
  })

  it('run 只给公开投影，待确认载荷与 turnId 一概不出边界', () => {
    const { access, store } = host()
    store.setter(runAtom, {
      runId: 'r1',
      status: 'waiting_confirmation',
      turnId: 't1',
      pendingToolConfirmation: { callId: 'c1', toolName: '__danger__', args: { path: '/etc' } },
    })
    // 与 observeRun 给出的是同一份 PluginRunSnapshot：两处形状不同的话，插件就得分辨手上是哪一份。
    expect(Object.keys(access.readSession('run') ?? {}).sort()).toEqual(['runId', 'status'])
  })

  it('读得到跨会话 root 的值', () => {
    const { access, root } = host()
    root.setter(activeSessionIdAtom, 's1')
    root.setter(workspacesAtom, { w1: { id: 'w1', name: '主工作区', rootPath: '/tmp/ws', createdAt: 0, updatedAt: 0 } })
    root.setter(activeWorkspaceIdAtom, 'w1')

    expect(access.readRoot('activeSessionId')).toBe('s1')
    // activeWorkspaceRootAtom 是派生的：能读到它，说明读面走的确实是 root store 而不是会话 store。
    expect(access.readRoot('activeWorkspaceRoot')).toBe('/tmp/ws')
  })

  it('items 给的是冻结的浅拷贝：改不动 store 里那份数组', () => {
    const { access, store } = host()
    store.setter(itemsAtom, [item('a', '你好')])
    const items = access.readSession('items')

    expect(Object.isFrozen(items)).toBe(true)
    expect(items).not.toBe(store.getter(itemsAtom))
    expect(() => (items as ConversationItem[]).push(item('b', '插一条'))).toThrow()
    expect(store.getter(itemsAtom)).toHaveLength(1)
  })

  it('读不设门：run 已过期、已中止也照样读得到那个会话此刻的真状态', () => {
    const { access, store, stale } = host({ aborted: true })
    store.setter(itemsAtom, [item('a', '你好')])
    stale()
    // 拦下读只会让插件既拿不到值、又得自己分辨「没有值」和「不让读」。门只开在写这一侧。
    expect(access.readSession('items')).toHaveLength(1)
  })
})

describe('createPluginStateAccess —— 写面入账', () => {
  it('整值槽位在日志里留下 (key, prev, next)，undo 回到 prev', () => {
    const { access, target, store } = host()
    expect(access.setContextCheckpoint(checkpoint)).toBe(true)

    const [entry] = target.history.getState().entries
    expect(entry?.ops).toEqual([{ key: 'contextCheckpoint', before: undefined, after: checkpoint }])

    expect(target.history.undo()).toBe(true)
    expect(store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(target.history.redo()).toBe(true)
    expect(store.getter(contextCheckpointAtom)).toBe(checkpoint)
  })

  it('appendItem 追加一条并只记这一条的账，undo 把它弹掉', () => {
    const { access, target, store } = host()
    store.setter(itemsAtom, [item('a', '第一句'), item('b', '第二句')])

    const id = access.appendItem({ role: 'system', content: '插件加的一句' })
    expect(typeof id).toBe('string')
    expect(store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['a', 'b', id])

    // 增量记账的证据：op 载荷里只有被追加的那一条，不是整条对话的两份完整副本
    // （整值记账 items 是二次开销，见 state/listSlotLog.ts 的实测）。
    const ops = target.history.getState().entries[0]?.ops ?? []
    expect(ops.map((op) => op.key)).toEqual(['items:append'])
    expect((ops[0]?.after as ConversationItem).item).toEqual({ role: 'system', content: '插件加的一句' })

    expect(target.history.undo()).toBe(true)
    expect(store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('id 与 createdAt 由 core 生成，插件不参与', () => {
    const { access, store } = host()
    const id = access.appendItem({ role: 'system', content: '一' })
    access.appendItem({ role: 'system', content: '二' })
    const items = store.getter(itemsAtom)

    expect(items[0]?.id).toBe(id)
    expect(new Set(items.map((entry) => entry.id)).size).toBe(2)
    expect(items.every((entry) => typeof entry.createdAt === 'number')).toBe(true)
  })

  it('写入没真改变值时不记账，但仍算接受（「没有变化」不是拒绝）', () => {
    const { access, target, store } = host()
    store.setter(contextCheckpointAtom, checkpoint)
    expect(access.setContextCheckpoint(checkpoint)).toBe(true)
    expect(target.history.getState().entries).toHaveLength(0)
  })
})

describe('createPluginStateAccess —— 写入门', () => {
  it('run 已不是当前 run（ghost / stale）时整体拒绝，不写不记账', () => {
    const { access, target, store, stale } = host()
    stale()

    expect(access.setContextCheckpoint(checkpoint)).toBe(false)
    expect(access.appendItem({ role: 'system', content: '迟到的回写' })).toBeUndefined()
    expect(store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(store.getter(itemsAtom)).toEqual([])
    expect(target.history.getState().entries).toHaveLength(0)
  })

  it('run 已中止时整体拒绝', () => {
    const { access, store } = host({ aborted: true })

    expect(access.setContextCheckpoint(checkpoint)).toBe(false)
    expect(access.appendItem({ role: 'system', content: '中止后的回写' })).toBeUndefined()
    expect(store.getter(itemsAtom)).toEqual([])
  })

  it('门是在调用时求值的：拿着同一个面跨过 run 边界也不会被放行', () => {
    const { access, store, stale } = host()
    // 插件在 await 之前拿到的面，await 之后 run 已经换人——它不必记得自己调 isCurrent()。
    expect(access.appendItem({ role: 'system', content: '第一次' })).toBeDefined()
    stale()
    expect(access.appendItem({ role: 'system', content: '第二次' })).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(1)
  })
})
