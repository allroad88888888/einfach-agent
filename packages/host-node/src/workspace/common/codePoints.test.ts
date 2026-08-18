import { describe, expect, it } from 'vitest'
import { countCodePoints, takeCodePoints } from './codePoints'

describe('countCodePoints', () => {
  it('按码点数，代理对算一个', () => {
    expect(countCodePoints('')).toBe(0)
    expect(countCodePoints('abc')).toBe(3)
    expect(countCodePoints('汉字')).toBe(2)
    expect(countCodePoints('a😀b')).toBe(3)
    expect('a😀b'.length).toBe(4)
  })

  it('孤立代理（非法但可能出现在坏输入里）按单个码点算，不会死循环', () => {
    expect(countCodePoints('\ud83d')).toBe(1)
    expect(countCodePoints('a\ud83db')).toBe(3)
  })
})

describe('takeCodePoints', () => {
  it('绝不把代理对切成一半', () => {
    expect(takeCodePoints('a😀b', 2)).toBe('a😀')
    expect(takeCodePoints('😀😀', 1)).toBe('😀')
  })

  it('上限不小于长度时原样返回，非正数时返回空串', () => {
    expect(takeCodePoints('abc', 3)).toBe('abc')
    expect(takeCodePoints('abc', 99)).toBe('abc')
    expect(takeCodePoints('abc', 0)).toBe('')
    expect(takeCodePoints('abc', -1)).toBe('')
  })
})
