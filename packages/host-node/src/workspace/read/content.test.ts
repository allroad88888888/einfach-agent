import { describe, expect, it } from 'vitest'
import { decodeUtf8, rejectBinaryBytes } from './content'

const utf8 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'))

describe('rejectBinaryBytes', () => {
  it('含 NUL 即拒，消息保留 Rust 英文原文', () => {
    expect(() => rejectBinaryBytes(new Uint8Array([0x61, 0x00]), 'a/b.bin')).toThrow(
      'refusing to read binary file `a/b.bin`',
    )
  })

  it('不含 NUL 放行', () => {
    expect(() => rejectBinaryBytes(utf8('plain text'), 'a/b.txt')).not.toThrow()
  })
})

describe('decodeUtf8（对齐 Rust 的 from_utf8 三分支）', () => {
  it('全合法：原样解出', () => {
    expect(decodeUtf8(utf8('ab你cd'), false, 'f.txt')).toBe('ab你cd')
  })

  it('尾部被切断 + 允许 → 只返回合法前缀（等价 Rust 的 valid_up_to）', () => {
    // "ab" + 你 的前 2 个字节
    expect(decodeUtf8(utf8('ab你cd').slice(0, 4), true, 'f.txt')).toBe('ab')
  })

  it('尾部被切断 + 不允许 → 判为非 UTF-8 文件', () => {
    expect(() => decodeUtf8(utf8('ab你cd').slice(0, 4), false, 'f.txt')).toThrow(
      'refusing to read non-UTF-8 file `f.txt`',
    )
  })

  it('中途非法字节 → 即使允许残缺尾部也拒（Rust 的 error_len 是 Some）', () => {
    expect(() => decodeUtf8(new Uint8Array([0x61, 0xff, 0x62]), true, 'f.txt')).toThrow(
      'refusing to read non-UTF-8 file `f.txt`',
    )
  })

  it('非法的续字节（0xe0 0x80）→ 拒', () => {
    expect(() => decodeUtf8(new Uint8Array([0x61, 0xe0, 0x80]), true, 'f.txt')).toThrow(
      /non-UTF-8/,
    )
  })

  it('开头的 BOM 原样保留，不被 TextDecoder 吃掉', () => {
    // 默认的 ignoreBOM:false 会把它删掉，于是 Node 侧比 Rust 少 3 个字节，续读位置整体错位。
    const decoded = decodeUtf8(utf8('\uFEFFhello'), false, 'f.txt')
    expect(decoded).toBe('\uFEFFhello')
    expect(Buffer.byteLength(decoded, 'utf8')).toBe(8)
  })

  it('空输入解成空串', () => {
    expect(decodeUtf8(new Uint8Array(), true, 'f.txt')).toBe('')
  })
})
