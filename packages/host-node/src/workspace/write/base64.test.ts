import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeBase64 } from './base64'
import { WriteRejection } from './result'

describe('decodeBase64', () => {
  it('对齐 apps/desktop/src/workspace_write_base64.rs 的 RFC 4648 测试向量', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array())
    expect(Buffer.from(decodeBase64('Zg=='))).toEqual(Buffer.from('f'))
    expect(Buffer.from(decodeBase64('Zm8='))).toEqual(Buffer.from('fo'))
    expect(Buffer.from(decodeBase64('Zm9v'))).toEqual(Buffer.from('foo'))
    expect(Buffer.from(decodeBase64('Zm9vYmFy'))).toEqual(Buffer.from('foobar'))
  })

  it('省略 padding 合法：模型生成的 base64 未必带 `=`', () => {
    expect(Buffer.from(decodeBase64('Zm8'))).toEqual(Buffer.from('fo'))
    expect(Buffer.from(decodeBase64('Zg'))).toEqual(Buffer.from('f'))
  })

  it('含空白：传输中的换行、空格、制表符是合法 padding，不影响解码结果', () => {
    const expected = Buffer.from('foobar')
    expect(Buffer.from(decodeBase64('Zm9v\nYmFy'))).toEqual(expected)
    expect(Buffer.from(decodeBase64('Zm9v YmFy'))).toEqual(expected)
    expect(Buffer.from(decodeBase64('Zm9v\tYmFy'))).toEqual(expected)
    expect(Buffer.from(decodeBase64('  Zm9vYmFy  '))).toEqual(expected)
  })

  it('空串解出空字节数组，不报错', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array())
    expect(decodeBase64('   \n\t')).toEqual(new Uint8Array()) // 全是空白也算空
  })

  it('非法字符：不在 alphabet 里的符号被拒，不会被跳过后继续解码', () => {
    expect(() => decodeBase64('not base64!')).toThrow(WriteRejection)
    expect(() => decodeBase64('not base64!')).toThrow(
      'content is not valid base64: unexpected character `!`',
    )
    // URL-safe 的 `-` `_` 不是这个 alphabet 的一部分。
    expect(() => decodeBase64('Zm9v-YmFy')).toThrow('unexpected character `-`')
  })

  it('padding 位置错误：`=` 出现在非末尾位置，不会被当成合法 padding 悄悄跳过', () => {
    // 'Z' '=' 'g' '=' —— 只有末尾一个 `=` 被当 padding，中间那个 `=` 落进 body 里当非法字符。
    expect(() => decodeBase64('Z=g=')).toThrow(
      'content is not valid base64: unexpected character `=`',
    )
  })

  it('padding 长度错误：三个及以上 `=`，或总长不是 4 的倍数时带 padding，都判 malformed padding', () => {
    expect(() => decodeBase64('Zg===')).toThrow(
      'content is not valid base64: malformed padding',
    )
    // 只给 1 个 `=`，但按 4 对齐本该是 2 个。
    expect(() => decodeBase64('Zg=')).toThrow('content is not valid base64: malformed padding')
    // 纯 padding，没有任何数据。
    expect(() => decodeBase64('==')).toThrow('content is not valid base64: malformed padding')
  })

  it('截断输入：单个字符只剩 6 位，凑不出一个完整字节', () => {
    expect(() => decodeBase64('a')).toThrow('content is not valid base64: truncated input')
  })

  it('与 Buffer.from(x, "base64") 对照：非法输入那里被静默吞成垃圾字节，这里明确报错且不产出任何字节', () => {
    const legacyGarbage = Buffer.from('not base64!', 'base64')
    // Buffer.from 对 "not base64!" 不抛错，是它糟糕的地方——静默产出了一串垃圾字节。
    expect(legacyGarbage.length).toBeGreaterThan(0)
    // decodeBase64 必须在这类输入上明确拒绝，而不是复用 Buffer.from 的宽松解码。
    expect(() => decodeBase64('not base64!')).toThrow(WriteRejection)
  })
})
