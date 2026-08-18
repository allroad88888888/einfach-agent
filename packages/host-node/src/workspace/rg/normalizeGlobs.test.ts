import { describe, expect, it } from 'vitest'
import { normalizeGlobs } from './normalizeGlobs'

describe('normalizeGlobs', () => {
  it('未传或非数组 → 空数组', () => {
    expect(normalizeGlobs(undefined)).toEqual([])
    expect(normalizeGlobs('not-an-array')).toEqual([])
    expect(normalizeGlobs(null)).toEqual([])
  })

  it('trim 后为空的条目被跳过，其余原样（含前导 `!` 否定 glob）保留', () => {
    expect(normalizeGlobs(['  ', '*.ts', '  !*.test.ts  '])).toEqual(['*.ts', '!*.test.ts'])
  })

  it('非字符串元素被跳过（没有 Rust 对应物的宽松策略，不拒绝整个请求）', () => {
    expect(normalizeGlobs(['*.ts', 42, null, { not: 'a string' }])).toEqual(['*.ts'])
  })

  it('含 NUL 字节被拒', () => {
    expect(() => normalizeGlobs(['a\0b'])).toThrow('NUL bytes')
  })

  it('以 / 或 \\ 开头的 glob 必须相对，被拒；否定 glob 的 `!` 前缀不算路径的一部分', () => {
    expect(() => normalizeGlobs(['/etc/passwd'])).toThrow('must be relative')
    expect(() => normalizeGlobs(['\\windows\\path'])).toThrow('must be relative')
    expect(() => normalizeGlobs(['!/etc/passwd'])).toThrow('must be relative')
    expect(normalizeGlobs(['!src/**'])).toEqual(['!src/**'])
  })

  it('含 `..` 分量被拒', () => {
    expect(() => normalizeGlobs(['../secret/**'])).toThrow('must not contain `..` components')
    expect(() => normalizeGlobs(['a/../b'])).toThrow('must not contain `..` components')
  })
})
