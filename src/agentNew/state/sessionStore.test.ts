import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionStore,
  dropSessionStore,
  getSessionStore,
  resetSessionStores,
} from './sessionStore'

// 每会话一个独立 store（C3）：工厂按需创建 + Map 缓存。
// 每个用例后清空 Map，保证会话之间彼此隔离，不残留。
afterEach(() => {
  resetSessionStores()
})

describe('sessionStore', () => {
  it('getSessionStore 同 id 幂等：连续两次返回同一实例（Map 缓存）', () => {
    const first = getSessionStore('a')
    const second = getSessionStore('a')

    expect(second).toBe(first)
    expect(second.store).toBe(first.store)
    expect(second.id).toBe('a')
  })

  it('不同 id 得到不同 store（各自 .store 也不同）', () => {
    const a = getSessionStore('a')
    const b = getSessionStore('b')

    expect(a).not.toBe(b)
    expect(a.store).not.toBe(b.store)
    expect(a.id).toBe('a')
    expect(b.id).toBe('b')
  })

  it('dropSessionStore 后再 get 是新实例（旧 store 已丢弃）', () => {
    const before = getSessionStore('a')

    dropSessionStore('a')

    const after = getSessionStore('a')
    expect(after).not.toBe(before)
    expect(after.store).not.toBe(before.store)
    expect(after.id).toBe('a')
  })

  it('createSessionStore 直接建新实例并写入缓存（后续 get 命中同实例）', () => {
    const created = createSessionStore('a')
    const fetched = getSessionStore('a')

    expect(fetched).toBe(created)
  })
})
