import { describe, expect, it } from 'vitest'
import { diffLines, diffMarker, splitLines } from './lineDiff'

describe('splitLines（Rust `str::lines()` 的等价物）', () => {
  it('结尾换行不产生空行，空串是零行', () => {
    // 直译 `split('\n')` 会给 ["a","b",""] 与 [""]，于是每个以换行结尾的文件都凭空多一行。
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })

  it('文件中间的空行照留，只有最后那一个不算', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b'])
    expect(splitLines('a\n\n')).toEqual(['a', ''])
    expect(splitLines('\n')).toEqual([''])
  })

  it('CRLF：换行符之前的 `\\r` 去掉，孤立的 `\\r` 保留', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('\r\n')).toEqual([''])
    // Rust 的 lines() 不在孤立 `\r` 处断行，它只是普通字符。
    expect(splitLines('a\rb')).toEqual(['a\rb'])
  })

  it('末行没有换行符时，它结尾的 `\\r` 属于内容——不能剥', () => {
    // Rust 的实现是先 strip_suffix('\n')，失败就整段原样返回。无条件剥的后果是
    // 「以 a\r 结尾（无换行）」与「以 a 结尾」被判成同一份内容，一次真实改动从 diff 里消失。
    // 这条是 patch 域（W13）与 write 域（W7）对照时发现的分歧点——W13 一度无条件剥掉，已改正。
    expect(splitLines('a\r')).toEqual(['a\r'])
    expect(splitLines('x\nb\r')).toEqual(['x', 'b\r'])
    expect(splitLines('\r')).toEqual(['\r'])
  })
})

describe('diffLines', () => {
  it('单行替换给出 keep/remove/add 三段', () => {
    expect(diffLines(['keep', 'old'], ['keep', 'new'])).toEqual([
      { tag: 'keep', line: 'keep' },
      { tag: 'remove', line: 'old' },
      { tag: 'add', line: 'new' },
    ])
  })

  it('平手时先删后加——`>=` 那一支，改成 `>` 会让每个替换块的加删顺序对调', () => {
    const edits = diffLines(['a'], ['b'])
    expect(edits.map((edit) => edit.tag)).toEqual(['remove', 'add'])
  })

  it('一侧为空时全部记成同一种编辑', () => {
    expect(diffLines([], ['x', 'y']).map((edit) => edit.tag)).toEqual(['add', 'add'])
    expect(diffLines(['x', 'y'], []).map((edit) => edit.tag)).toEqual(['remove', 'remove'])
  })

  it('中间插入一行时保留两侧的公共行', () => {
    expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { tag: 'keep', line: 'a' },
      { tag: 'add', line: 'b' },
      { tag: 'keep', line: 'c' },
    ])
  })
})

describe('diffMarker', () => {
  it('三个标记与 Rust `DiffTag::marker()` 一致', () => {
    expect(diffMarker('keep')).toBe(' ')
    expect(diffMarker('add')).toBe('+')
    expect(diffMarker('remove')).toBe('-')
  })
})
