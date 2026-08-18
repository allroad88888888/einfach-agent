import { describe, expect, it } from 'vitest'
import { parseEncoding, parseMode } from './options'
import { WriteRejection } from './result'

describe('parseMode', () => {
  it('缺省是 create——写一个已存在的文件必须是明确的意图', () => {
    expect(parseMode(undefined)).toBe('create')
  })

  it.each(['create', 'overwrite', 'append', 'upsert'] as const)('收 %s', (mode) => {
    expect(parseMode(mode)).toBe(mode)
  })

  it('非法值给出取值集合', () => {
    expect(() => parseMode('replace')).toThrow(WriteRejection)
    expect(() => parseMode('replace')).toThrow(
      'invalid mode `replace`; expected `create`, `overwrite`, `upsert`, or `append`',
    )
  })
})

describe('parseEncoding', () => {
  it('缺省是 utf8', () => {
    expect(parseEncoding(undefined)).toBe('utf8')
  })

  it('utf-8 与 utf8 同义', () => {
    expect(parseEncoding('utf-8')).toBe('utf8')
    expect(parseEncoding('utf8')).toBe('utf8')
  })

  it('base64 是合法取值（解码本身归 W8）', () => {
    expect(parseEncoding('base64')).toBe('base64')
  })

  it('非法值给出取值集合', () => {
    expect(() => parseEncoding('hex')).toThrow('invalid encoding `hex`; expected `utf8` or `base64`')
  })
})
