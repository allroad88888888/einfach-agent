import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES,
  validateFileText,
  validateNonEmptyTextInput,
  validateTextInput,
} from './limits'

describe('patch 的文本上限', () => {
  it('上限是 1 MiB，文案里带的就是这个数字', () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024)
    expect(() => validateTextInput('content', 'a'.repeat(MAX_FILE_BYTES + 1))).toThrow(
      'content exceeds 1048576 byte limit',
    )
  })

  it('正好压线放行', () => {
    expect(() => validateTextInput('content', 'a'.repeat(MAX_FILE_BYTES))).not.toThrow()
  })

  it('按**字节**数而不是字符数（Rust 是 `as_bytes().len()`）', () => {
    // 直译成 .length 会让这份 1.2 MB 的中文正文被判成没超 1 MiB 而放行。
    const text = '中'.repeat(MAX_FILE_BYTES / 3 + 1)
    expect(text.length).toBeLessThan(MAX_FILE_BYTES)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_FILE_BYTES)
    expect(() => validateTextInput('content', text)).toThrow(/exceeds 1048576 byte limit/)
  })

  it('含 NUL → 当二进制拒；label 原样出现在文案里', () => {
    expect(() => validateTextInput('newText', 'a\0b')).toThrow(/^newText appears to be binary$/)
  })

  it('大小先判、二进制后判（同时犯规时报大小）', () => {
    expect(() => validateTextInput('content', `\0${'a'.repeat(MAX_FILE_BYTES)}`)).toThrow(
      /exceeds 1048576 byte limit/,
    )
  })

  it('validateNonEmptyTextInput 多一条空串检查，且排在最前', () => {
    expect(() => validateNonEmptyTextInput('oldText', '')).toThrow(/^oldText must be non-empty$/)
    expect(() => validateNonEmptyTextInput('oldText', ' ')).not.toThrow()
  })

  it('validateFileText 与 validateTextInput 同规则，只是 label 不同', () => {
    expect(() => validateFileText('resulting file content', 'a\0b')).toThrow(
      /^resulting file content appears to be binary$/,
    )
  })
})
