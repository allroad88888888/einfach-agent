// 哈希的期望值不是「跑一遍 Node 记下来」的——它们是用 apps/desktop 同版 `sha2 = "0.10"` 的
// `format!("sha256:{:x}", Sha256::digest(bytes))` 实跑出来的输出，逐字符抄在这里。
// 这四条锁的是**跨语言**一致：算法或编码漂移不会报错，只会让桌面端写的文件在 Node 宿主下过
// 不了 write_file 的乐观并发检查（反之亦然）。`abc` 那条同时是 FIPS 180-4 的公开测试向量。
import { describe, expect, it } from 'vitest'
import { contentSha256, decodeUtf8, rejectBinaryBytes } from './content'

const utf8 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'))

describe('contentSha256（与 Rust sha2 0.10 逐字符对拍）', () => {
  it.each([
    ['', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'hello read world',
      'sha256:bf730c677a8b2c9ca0df7011f9d36089ff79f0b3826d8f7ebe2fc11e57c0c4ba',
    ],
    ['ab你cd', 'sha256:561a2db4be952f22952b3dbc8805534d5fdd44cb6d12abd494f701b67af1b02f'],
  ])('sha256(%j)', (input, expected) => {
    expect(contentSha256(utf8(input))).toBe(expected)
  })

  it('形状是 sha256:<64 位小写 hex>（Rust 侧 write guard 只收这一种）', () => {
    expect(contentSha256(utf8('x'))).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

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
