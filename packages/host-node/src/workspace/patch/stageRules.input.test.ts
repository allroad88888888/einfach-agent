// `validatePatchOperationInput`：四个变体各自跑哪几条入参校验。
// 校验规则本身（字节口径、NUL、空串）由 limits.test.ts 直接盯；这里只盯**派发**——
// 哪个变体校验哪个字段、label 用哪个名字，那是模型看到的错误文案。
// 另一个导出 `nextFileState` 的用例在 stageRules.test.ts。
import { describe, expect, it } from 'vitest'
import { validatePatchOperationInput } from './stageRules'
import { MAX_FILE_BYTES } from './limits'

describe('validatePatchOperationInput（只看入参，先于路径解析）', () => {
  it('add_file / overwrite_file 校验 content，label 就叫 content', () => {
    const oversizedText = '中'.repeat(MAX_FILE_BYTES / 3 + 1) // 每字 3 字节
    expect(oversizedText.length).toBeLessThan(MAX_FILE_BYTES)
    for (const type of ['add_file', 'overwrite_file'] as const) {
      expect(() =>
        validatePatchOperationInput({ type, path: 'a.txt', content: oversizedText }),
      ).toThrow(`content exceeds ${MAX_FILE_BYTES} byte limit`)
    }
  })

  it('delete_file / overwrite_file 的 oldContent 给了才校验', () => {
    expect(() => validatePatchOperationInput({ type: 'delete_file', path: 'a.txt' })).not.toThrow()
    expect(() =>
      validatePatchOperationInput({ type: 'delete_file', path: 'a.txt', oldContent: 'a\0b' }),
    ).toThrow(/^oldContent appears to be binary$/)
    expect(() =>
      validatePatchOperationInput({
        type: 'overwrite_file',
        path: 'a.txt',
        content: 'ok',
        oldContent: 'a\0b',
      }),
    ).toThrow(/^oldContent appears to be binary$/)
  })

  it('replace 校验 oldText（非空）与 newText', () => {
    expect(() =>
      validatePatchOperationInput({ type: 'replace', path: 'a.txt', oldText: '', newText: 'x' }),
    ).toThrow(/^oldText must be non-empty$/)
    expect(() =>
      validatePatchOperationInput({ type: 'replace', path: 'a.txt', oldText: 'a', newText: 'a\0b' }),
    ).toThrow(/^newText appears to be binary$/)
  })

  it('expectedReplacements 必须为正；不给则不校验', () => {
    for (const expectedReplacements of [0, -1]) {
      expect(() =>
        validatePatchOperationInput({
          type: 'replace',
          path: 'a.txt',
          oldText: 'a',
          newText: 'b',
          expectedReplacements,
        }),
      ).toThrow(/^expectedReplacements must be greater than 0$/)
    }
    expect(() =>
      validatePatchOperationInput({ type: 'replace', path: 'a.txt', oldText: 'a', newText: 'b' }),
    ).not.toThrow()
  })
})
