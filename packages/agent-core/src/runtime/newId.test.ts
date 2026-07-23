// newId 的单测（红→绿）。
// ---------------------------------------------------------------------------
// 契约：生成稳定唯一 id；crypto 全局未定义的环境也不得 ReferenceError（typeof 守卫）。
// 本测只断言可观察行为：返回非空 string，且两次调用互不相等。

import { describe, expect, it } from 'vitest'
import { newId } from './newId'

describe('newId', () => {
  it('返回非空 string', () => {
    const id = newId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('两次调用不相等', () => {
    expect(newId()).not.toBe(newId())
  })
})
