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

  it('base64 目前以结构化拒绝返回（W8 未落地），且明说了可用的替代', () => {
    // 这条会随 W8 一起改。留着它是为了让「悄悄退化成写垃圾字节」不可能发生——
    // Buffer.from(x, 'base64') 对非法字符是静默跳过的。
    expect(() => buildPayload('iVBORw0KGgo=', 'base64')).toThrow(WriteRejection)
    expect(() => buildPayload('iVBORw0KGgo=', 'base64')).toThrow('base64')
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
