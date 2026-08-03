import { afterEach, describe, expect, it, vi } from 'vitest'

import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'
import { itemsAtom, runAtom } from './sessionAtoms'
import {
  appendItem,
  patchRun,
  setItems,
  setRun,
  setRunStatus,
  touchSession,
  updateItem,
} from './sessionWriters'
import type { ConversationItem } from './core.type'
import { createCoreInstance, type CoreInstance } from '../runtime/core/coreInstance'

// P5 会话状态写入器 —— 单测先行（C6）。写入器操作「当前会话的 store」，
// ghost guard 查 rootStore.sessionsAtom（会话登记表），内容写各自 session store。

afterEach(() => {
  vi.restoreAllMocks()
})

// 在 rootStore 登记表里 seed 一个 s1 会话（否则 ghost guard 会拦掉写入）。
function seedSession(id = 's1'): void {
  rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

// 同上，但登记进「独立 core 实例」自己的 rootStore（穿线用例：验证隔离）。
function seedSessionInCore(core: CoreInstance, id = 's1'): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

const sampleItem: ConversationItem = {
  id: 'i1',
  createdAt: 1,
  item: { role: 'user', content: 'hi' },
}

describe('appendItem', () => {
  it('把 item 追加到该会话 store 的 itemsAtom', () => {
    seedSession()
    appendItem('s1', sampleItem)
    expect(getSessionStore('s1').store.getter(itemsAtom)).toContainEqual(sampleItem)
  })

  it('产生新数组引用（不可变更新，C4）', () => {
    seedSession()
    const before = getSessionStore('s1').store.getter(itemsAtom)
    appendItem('s1', sampleItem)
    const after = getSessionStore('s1').store.getter(itemsAtom)
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
  })

  it('收尾 touchSession —— 该会话 updatedAt 前进', () => {
    seedSession()
    let now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    appendItem('s1', sampleItem)
    expect(rootStore.getter(sessionsAtom).s1.updatedAt).toBeGreaterThan(0)
  })

  it('未登记会话 → ghost guard no-op（C7）', () => {
    // 不 seed 'sX'（rootStore 没有登记）
    appendItem('sX', sampleItem)
    expect(getSessionStore('sX').store.getter(itemsAtom)).toEqual([])
  })
})

describe('updateItem', () => {
  it('合并 patch 到匹配 id 的 item', () => {
    seedSession()
    appendItem('s1', sampleItem)
    updateItem('s1', 'i1', { pending: true })
    const items = getSessionStore('s1').store.getter(itemsAtom)
    expect(items[0]).toMatchObject({ id: 'i1', pending: true })
  })

  it('产生新数组引用（C4）', () => {
    seedSession()
    appendItem('s1', sampleItem)
    const before = getSessionStore('s1').store.getter(itemsAtom)
    updateItem('s1', 'i1', { pending: true })
    const after = getSessionStore('s1').store.getter(itemsAtom)
    expect(after).not.toBe(before)
  })

  it('未登记会话 → no-op', () => {
    updateItem('sX', 'i1', { pending: true })
    expect(getSessionStore('sX').store.getter(itemsAtom)).toEqual([])
  })
})

describe('setItems', () => {
  it('整体替换该会话 store 的 itemsAtom，并 touchSession', () => {
    seedSession()
    let now = 200
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    appendItem('s1', sampleItem)
    const next: ConversationItem[] = [{ id: 'i2', createdAt: 2, item: { role: 'assistant', content: 'ok' } }]

    setItems('s1', next)

    expect(getSessionStore('s1').store.getter(itemsAtom)).toBe(next)
    expect(rootStore.getter(sessionsAtom).s1.updatedAt).toBeGreaterThan(0)
  })

  it('未登记会话 → no-op', () => {
    setItems('sX', [sampleItem])
    expect(getSessionStore('sX').store.getter(itemsAtom)).toEqual([])
  })
})

describe('setRun / patchRun / setRunStatus', () => {
  it('setRun 写入 runAtom', () => {
    seedSession()
    setRun('s1', { runId: 'r1', status: 'running' })
    expect(getSessionStore('s1').store.getter(runAtom)).toEqual({
      runId: 'r1',
      status: 'running',
    })
  })

  it('setRun(undefined) 清空 runAtom', () => {
    seedSession()
    setRun('s1', { runId: 'r1', status: 'running' })
    setRun('s1', undefined)
    expect(getSessionStore('s1').store.getter(runAtom)).toBeUndefined()
  })

  it('patchRun 合并到已有 run', () => {
    seedSession()
    setRun('s1', { runId: 'r1', status: 'running' })
    patchRun('s1', { status: 'done', error: 'x' })
    expect(getSessionStore('s1').store.getter(runAtom)).toEqual({
      runId: 'r1',
      status: 'done',
      error: 'x',
    })
  })

  it('patchRun 无既有 run → 不创建（return）', () => {
    seedSession()
    patchRun('s1', { status: 'done' })
    expect(getSessionStore('s1').store.getter(runAtom)).toBeUndefined()
  })

  it('setRunStatus 走 patchRun 改 status（含 stopped）', () => {
    seedSession()
    setRun('s1', { runId: 'r1', status: 'running' })
    setRunStatus('s1', 'stopped')
    expect(getSessionStore('s1').store.getter(runAtom)?.status).toBe('stopped')
  })

  it('未登记会话 → setRun no-op', () => {
    setRun('sX', { runId: 'r1', status: 'running' })
    expect(getSessionStore('sX').store.getter(runAtom)).toBeUndefined()
  })
})

describe('touchSession', () => {
  it('更新该会话 updatedAt，且不可变更新登记表', () => {
    seedSession()
    let now = 500
    vi.spyOn(Date, 'now').mockImplementation(() => ++now)
    const before = rootStore.getter(sessionsAtom)
    touchSession('s1')
    const after = rootStore.getter(sessionsAtom)
    expect(after).not.toBe(before)
    expect(after.s1.updatedAt).toBeGreaterThanOrEqual(before.s1.updatedAt)
  })

  it('未登记会话 → no-op', () => {
    seedSession()
    const before = rootStore.getter(sessionsAtom)
    touchSession('sX')
    expect(rootStore.getter(sessionsAtom)).toBe(before)
  })
})

// 【实例化 · 第 2 期穿线】传入独立 core 时，写入只落在该 core 自己的 store，
// 不摸 defaultCore（模块级 rootStore/getSessionStore 背后就是 defaultCore）——第 3 期隔离雏形，
// 同时也验证「传入的 core 真被用上」而不是被默认参数悄悄顶掉。
describe('core 穿线 —— 传入独立 core 时写入隔离于 defaultCore', () => {
  it('appendItem 传独立 core：写入落在该 core 的 store，defaultCore 同 id 的 store 保持干净', () => {
    seedSession('s1') // 登记进 defaultCore 的 rootStore（防止「未登记」掩盖了隔离问题）
    const core = createCoreInstance()
    seedSessionInCore(core, 's1') // 同一个 id 也要登记进独立 core 自己的 rootStore，否则 ghost guard 会拦掉

    appendItem('s1', sampleItem, core)

    expect(core.getSessionStore('s1').store.getter(itemsAtom)).toContainEqual(sampleItem)
    expect(getSessionStore('s1').store.getter(itemsAtom)).toEqual([]) // defaultCore 未被污染
  })

  it('setRun 传独立 core：写入落在该 core 的 store，defaultCore 同 id 的 runAtom 保持 undefined', () => {
    seedSession('s1')
    const core = createCoreInstance()
    seedSessionInCore(core, 's1')

    setRun('s1', { runId: 'r1', status: 'running' }, core)

    expect(core.getSessionStore('s1').store.getter(runAtom)).toEqual({
      runId: 'r1',
      status: 'running',
    })
    expect(getSessionStore('s1').store.getter(runAtom)).toBeUndefined() // defaultCore 未被污染
  })

  it('touchSession 传独立 core：只 touch 该 core 自己的登记表，defaultCore 的登记表不变', () => {
    seedSession('s1')
    const core = createCoreInstance()
    seedSessionInCore(core, 's1')
    const defaultBefore = rootStore.getter(sessionsAtom)

    touchSession('s1', core)

    expect(core.rootStore.getter(sessionsAtom).s1.updatedAt).toBeGreaterThan(0)
    expect(rootStore.getter(sessionsAtom)).toBe(defaultBefore) // defaultCore 登记表原样未动
  })

  it('未在独立 core 登记（只在 defaultCore 登记）→ 传 core 时 ghost guard 仍 no-op', () => {
    seedSession('s1') // 只登记进 defaultCore，不登记进 core
    const core = createCoreInstance()

    appendItem('s1', sampleItem, core)

    expect(core.getSessionStore('s1').store.getter(itemsAtom)).toEqual([])
  })

  it('不传 core 的既有调用点：默认落在 defaultCore（穿线前后行为逐字一致）', () => {
    seedSession('s1')
    appendItem('s1', sampleItem)
    expect(getSessionStore('s1').store.getter(itemsAtom)).toContainEqual(sampleItem)
  })
})
