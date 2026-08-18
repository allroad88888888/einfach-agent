import { describe, expect, it } from 'vitest'
import {
  normalizeCaseSensitive,
  normalizeContextLines,
  normalizeMaxMatches,
  normalizeQuery,
  normalizeRegex,
} from './normalizeRgInput'

describe('normalizeQuery', () => {
  it('trim 两端空白', () => {
    expect(normalizeQuery('  hello  ')).toBe('hello')
  })
  it('非字符串或全空白 → 空串（由 handler 据此判定为非法请求）', () => {
    expect(normalizeQuery(undefined)).toBe('')
    expect(normalizeQuery(42)).toBe('')
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('normalizeContextLines：unwrap_or(DEFAULT).min(MAX)', () => {
  it('未传 → 默认值', () => {
    expect(normalizeContextLines(undefined, 0, 5)).toBe(0)
  })
  it('传了合法值 → 原样（未超上限时）', () => {
    expect(normalizeContextLines(3, 0, 5)).toBe(3)
  })
  it('超过上限 → 钳到上限（不是拒绝）', () => {
    expect(normalizeContextLines(999, 0, 5)).toBe(5)
  })
  it('0 是合法值，不退回默认值以外的东西（本例默认恰好也是 0）', () => {
    expect(normalizeContextLines(0, 0, 5)).toBe(0)
  })
  it('负数/非整数/非数字 → 视为未传，退回默认值（无 Rust 对应物的兜底）', () => {
    expect(normalizeContextLines(-1, 2, 5)).toBe(2)
    expect(normalizeContextLines(1.5, 2, 5)).toBe(2)
    expect(normalizeContextLines('3', 2, 5)).toBe(2)
    expect(normalizeContextLines(Number.NaN, 2, 5)).toBe(2)
  })
})

describe('normalizeMaxMatches：value > 0 ? value.min(MAX) : DEFAULT', () => {
  it('未传 → 默认值', () => {
    expect(normalizeMaxMatches(undefined, 200, 1000)).toBe(200)
  })
  it('0 → 退回默认值，不是「不限」', () => {
    expect(normalizeMaxMatches(0, 200, 1000)).toBe(200)
  })
  it('正数在上限内 → 原样', () => {
    expect(normalizeMaxMatches(50, 200, 1000)).toBe(50)
  })
  it('超过上限 → 钳到上限', () => {
    expect(normalizeMaxMatches(5000, 200, 1000)).toBe(1000)
  })
  it('负数/非法值 → 退回默认值', () => {
    expect(normalizeMaxMatches(-5, 200, 1000)).toBe(200)
    expect(normalizeMaxMatches('50', 200, 1000)).toBe(200)
  })
})

describe('normalizeRegex / normalizeCaseSensitive：布尔默认值', () => {
  it('regex 默认 false', () => {
    expect(normalizeRegex(undefined)).toBe(false)
    expect(normalizeRegex(true)).toBe(true)
    expect(normalizeRegex('true')).toBe(false)
  })
  it('caseSensitive 默认 true', () => {
    expect(normalizeCaseSensitive(undefined)).toBe(true)
    expect(normalizeCaseSensitive(false)).toBe(false)
    expect(normalizeCaseSensitive('false')).toBe(true)
  })
})
