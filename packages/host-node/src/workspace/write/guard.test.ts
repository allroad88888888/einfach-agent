import { describe, expect, it } from 'vitest'
import { verifyExpectedContent } from './guard'
import { WriteRejection } from './result'
import type { BeforeContent } from './before'

const text = (value: string): BeforeContent => ({ kind: 'text', text: value })

/** 守卫的失败一律是 `WriteRejection`（结构化拒绝），拿到消息文本好逐字比对。 */
function rejectionOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WriteRejection)
    return (error as Error).message
  }
  throw new Error('应当被拒绝，但通过了')
}

describe('verifyExpectedContent', () => {
  it('两个守卫都没给就不校验', () => {
    expect(() => verifyExpectedContent(text('anything'), undefined, undefined)).not.toThrow()
  })

  it('两个守卫同时给出直接拒', () => {
    const message = rejectionOf(() =>
      verifyExpectedContent(text('a'), 'a', `sha256:${'0'.repeat(64)}`),
    )
    expect(message).toBe('pass either expectedOldContent or expectedContentHash, not both')
  })

  it('expectedOldContent 不匹配时报出差异形状与出路', () => {
    // 与 Rust 的 expected_old_content_mismatch_reports_exact_difference_shape 同一组数字。
    const message = rejectionOf(() => verifyExpectedContent(text('line\n\n'), 'line\n', undefined))
    expect(message).toBe(
      'expectedOldContent does not match current file content (expected_bytes=5, ' +
        'current_bytes=6, first_mismatch_byte=5, expected_trailing_lf=1, current_trailing_lf=2). ' +
        'Re-read the complete, untruncated file and pass it exactly, including final newlines; ' +
        'do not pass a snippet',
    )
  })

  it('字节数与首个不同字节按 UTF-8 字节算，不是 UTF-16 码元', () => {
    // 直译成 `.length` 的话：expected_bytes 会是 2、first_mismatch_byte 会是 1，
    // 模型照着那个位置去找，找到的是另一处。
    const message = rejectionOf(() => verifyExpectedContent(text('中x'), '中y', undefined))
    expect(message).toContain('expected_bytes=4')
    expect(message).toContain('current_bytes=4')
    expect(message).toContain('first_mismatch_byte=3')
  })

  it('一方是另一方的前缀时，首个不同字节取较短的长度', () => {
    const message = rejectionOf(() => verifyExpectedContent(text('abcd'), 'ab', undefined))
    expect(message).toContain('first_mismatch_byte=2')
  })

  it('内容完全相同就通过', () => {
    expect(() => verifyExpectedContent(text('same\n'), 'same\n', undefined)).not.toThrow()
  })

  it('文件不存在时守卫无从校验，报「不存在」而不是「不匹配」', () => {
    const message = rejectionOf(() => verifyExpectedContent({ kind: 'missing' }, 'old', undefined))
    expect(message).toBe(
      'failed to read existing file for optimistic guard: file does not exist',
    )
  })

  it('旧内容读不成文本时把理由原样带出来', () => {
    const message = rejectionOf(() =>
      verifyExpectedContent(
        { kind: 'unsupported', reason: 'binary files are not reversible' },
        'old',
        undefined,
      ),
    )
    expect(message).toBe(
      'failed to read existing file for optimistic guard: binary files are not reversible',
    )
  })
})

describe('expectedContentHash', () => {
  // FIPS 180-4 的公开测试向量，**不是**「跑一遍 Node 记下来的值」——算法或编码写错时它会红，
  // 而拿被测实现自己的输出当期望值不会。同一个值也钉在 read 域的 content.test.ts 里。
  const ABC = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

  it('hash 与当前内容一致就通过', () => {
    expect(() => verifyExpectedContent(text('abc'), undefined, ABC)).not.toThrow()
  })

  it('内容变过之后旧 hash 必须被拒，并说明出路是重读', () => {
    const message = rejectionOf(() => verifyExpectedContent(text('abcd'), undefined, ABC))
    expect(message).toBe(
      'expectedContentHash does not match current file content; the file changed after ' +
        'read_file. Re-read it and retry with the new contentHash',
    )
  })

  it.each([
    ['缺前缀', 'a'.repeat(64)],
    ['大写 hex', `sha256:${'A'.repeat(64)}`],
    ['长度不对', `sha256:${'a'.repeat(63)}`],
    ['非 hex 字符', `sha256:${'g'.repeat(64)}`],
  ])('格式不合法（%s）报的是格式错，不是不匹配', (_label, value) => {
    const message = rejectionOf(() => verifyExpectedContent(text('x'), undefined, value))
    expect(message).toBe('expectedContentHash must use sha256:<64 lowercase hex characters>')
  })
})
