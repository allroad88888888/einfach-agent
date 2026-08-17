import { describe, it, expect } from 'vitest'
import { createStore } from '@einfach/core'
import type { ConversationItem } from './core.type'
import {
  itemsAtom,
  runAtom,
} from './sessionAtoms'

// 核心断言：会话内 atom 是「共享单例 key」，值随 store 隔离（C3）。
// 用两个独立 createStore() 证明——往 a 写 itemsAtom 不影响 b，
// 这正是「每会话一个 store」不需要 Record<sessionId> 分桶的原因。
describe('sessionAtoms', () => {
  const item: ConversationItem = {
    id: 'i1',
    createdAt: 0,
    item: { role: 'user', content: 'hi' },
  }

  it('同一 itemsAtom 在不同 store 里值互相隔离（不分桶）', () => {
    const a = createStore()
    const b = createStore()

    a.setter(itemsAtom, [item])

    expect(a.getter(itemsAtom)).toHaveLength(1)
    // b 从未写过 → 仍是各自 store 的独立默认值
    expect(b.getter(itemsAtom)).toEqual([])
    expect(b.getter(itemsAtom)).toHaveLength(0)
  })

  it('各 atom 默认值正确（新 store 未写入时）', () => {
    const b = createStore()

    expect(b.getter(itemsAtom)).toEqual([])
    expect(b.getter(runAtom)).toBeUndefined()
  })
})
