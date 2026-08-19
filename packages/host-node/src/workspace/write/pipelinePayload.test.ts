import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { buildPayload, recoverPayloadText } from './pipelinePayload'
import { WriteRejection } from './result'

describe('buildPayload', () => {
  it('utf8：字节按 UTF-8 编码，文本视图就是原串', () => {
    const payload = buildPayload('中文 abc', 'utf8')
    expect(Buffer.from(payload.bytes).toString('utf8')).toBe('中文 abc')
    expect(payload.bytes.length).toBe(Buffer.byteLength('中文 abc', 'utf8'))
    expect(payload.text).toBe('中文 abc')
  })

  it('base64 承载二进制：字节按 base64 解码，文本视图为 null（含 NUL，不是合法文本）', () => {
    // PNG 文件头，含 0x00。
    const payload = buildPayload('iVBORw0KGgoA/w==', 'base64')
    expect(Buffer.from(payload.bytes).toString('hex')).toBe(
      Buffer.from('iVBORw0KGgoA/w==', 'base64').toString('hex'),
    )
    expect(payload.text).toBeNull()
  })

  it('base64 承载文本：解出合法 UTF-8 且不含 NUL 时，文本视图原样保留，不会被误判成二进制', () => {
    const payload = buildPayload('5Lit5paH', 'base64') // "中文"
    expect(Buffer.from(payload.bytes).toString('utf8')).toBe('中文')
    expect(payload.text).toBe('中文')
  })

  it('base64 非法输入按设计拒绝，而不是像 Buffer.from 那样静默解出垃圾字节', () => {
    expect(() => buildPayload('not base64!', 'base64')).toThrow(WriteRejection)
    expect(() => buildPayload('not base64!', 'base64')).toThrow('base64')
  })
})

describe('recoverPayloadText', () => {
  it('合法 UTF-8 且不含 NUL → 仍按文本对待（base64 常被用来传普通文本）', () => {
    expect(recoverPayloadText(Buffer.from('hello\n', 'utf8'))).toBe('hello\n')
  })

  it('含 NUL → 二进制', () => {
    expect(recoverPayloadText(Uint8Array.from([0x61, 0x00, 0x62]))).toBeNull()
  })

  it('非 UTF-8 → 二进制', () => {
    expect(recoverPayloadText(Uint8Array.from([0xff, 0xfe, 0x41]))).toBeNull()
  })

  it('BOM 原样保留，不被当作 BOM 吃掉', () => {
    expect(recoverPayloadText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a')
  })
})
