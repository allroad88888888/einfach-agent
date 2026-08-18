// `nextFileState`（四个操作各自的状态迁移）。另一个导出
// `validatePatchOperationInput` 的用例在 stageRules.input.test.ts。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nextFileState } from './stageRules'
import { MAX_FILE_BYTES } from './limits'
import type { PatchFileState, PatchOperation } from './types'

const hashOf = (content: string) =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const state = (
  initial: string | null,
  current: string | null,
  executable: boolean | null = null,
): PatchFileState => ({ initial, current, executable })

const fresh = state(null, null)

describe('nextFileState · add_file', () => {
  it('全新路径：写入 current，initial 保持 null', () => {
    expect(nextFileState(fresh, { type: 'add_file', path: 'a.txt', content: 'hi' })).toEqual(
      state(null, 'hi'),
    )
  })

  it('当前内容还在 → `file already exists`', () => {
    expect(() =>
      nextFileState(state('on disk', 'on disk'), {
        type: 'add_file',
        path: 'a.txt',
        content: 'hi',
      }),
    ).toThrow(/^file already exists$/)
  })

  it('本批开始时磁盘上就有（哪怕已被 delete 置空）→ 指路 overwrite_file', () => {
    // delete + add 同路径若放行，就绕过了 overwrite_file 对已存在文件要求 oldContent 的守卫。
    expect(() =>
      nextFileState(state('on disk', null), { type: 'add_file', path: 'a.txt', content: 'hi' }),
    ).toThrow(/^file already exists on disk; use overwrite_file to replace an existing file$/)
  })

  it('本批内 新建 → 删 → 再建：initial 始终为 null，放行', () => {
    const added = nextFileState(fresh, { type: 'add_file', path: 'a.txt', content: 'first' })
    const deleted = nextFileState(added, { type: 'delete_file', path: 'a.txt' })
    expect(nextFileState(deleted, { type: 'add_file', path: 'a.txt', content: 'second' })).toEqual(
      state(null, 'second'),
    )
  })

  it('executable 只在显式给出时改写，false 也是显式', () => {
    expect(
      nextFileState(fresh, { type: 'add_file', path: 'a.txt', content: 'x', executable: true }),
    ).toEqual(state(null, 'x', true))
    expect(
      nextFileState(state(null, null, true), {
        type: 'add_file',
        path: 'a.txt',
        content: 'x',
        executable: false,
      }),
    ).toEqual(state(null, 'x', false))
    expect(nextFileState(state(null, null, true), {
      type: 'add_file',
      path: 'a.txt',
      content: 'x',
    })).toEqual(state(null, 'x', true))
  })
})

describe('nextFileState · delete_file', () => {
  it('文件不存在 → `file does not exist`', () => {
    expect(() => nextFileState(fresh, { type: 'delete_file', path: 'a.txt' })).toThrow(
      /^file does not exist$/,
    )
  })

  it('无守卫直接删；current 置空、initial 不动', () => {
    expect(nextFileState(state('old', 'old'), { type: 'delete_file', path: 'a.txt' })).toEqual(
      state('old', null),
    )
  })

  it('oldContent 与暂存的当前内容不符 → 拒', () => {
    expect(() =>
      nextFileState(state('old', 'staged'), {
        type: 'delete_file',
        path: 'a.txt',
        oldContent: 'old',
      }),
    ).toThrow(/^oldContent did not match current file content$/)
  })

  it('expectedContentHash 比的也是**暂存后**的内容', () => {
    expect(
      nextFileState(state('old', 'staged'), {
        type: 'delete_file',
        path: 'a.txt',
        expectedContentHash: hashOf('staged'),
      }),
    ).toEqual(state('old', null))
  })
})

describe('nextFileState · replace', () => {
  it('默认期望恰好 1 处；命中 1 处则替换', () => {
    expect(
      nextFileState(state('a b a', 'a b a'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'b',
        newText: 'B',
      }),
    ).toEqual(state('a b a', 'a B a'))
  })

  it('一处都没有 → `oldText was not found`', () => {
    expect(() =>
      nextFileState(state('abc', 'abc'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'zzz',
        newText: 'x',
      }),
    ).toThrow(/^oldText was not found$/)
  })

  it('出现次数与期望不符 → 报出两个数，一处都不改', () => {
    expect(() =>
      nextFileState(state('a a a', 'a a a'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'a',
        newText: 'b',
      }),
    ).toThrow(/^replacement count mismatch: expected 1, found 3$/)
  })

  it('expectedReplacements 命中时全部替换', () => {
    expect(
      nextFileState(state('a a a', 'a a a'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'a',
        newText: 'b',
        expectedReplacements: 3,
      }),
    ).toEqual(state('a a a', 'b b b'))
  })

  it('计数与替换都是**不重叠、从左到右**（`aaaa` 里的 `aa` 是 2 处）', () => {
    expect(
      nextFileState(state('aaaa', 'aaaa'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'aa',
        newText: 'b',
        expectedReplacements: 2,
      }),
    ).toEqual(state('aaaa', 'bb'))
  })

  it('newText 里的 `$&` / `$1` 是字面量，不当替换模式展开', () => {
    // 直译成 String.prototype.replaceAll 会在这里把 `$&` 换成被匹配的文本，静默改写模型给的正文。
    expect(
      nextFileState(state('x', 'x'), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'x',
        newText: "$& $1 $' $$",
      }),
    ).toEqual(state('x', "$& $1 $' $$"))
  })

  it('替换后的整份文本也要过上限，label 是 `resulting file content`', () => {
    // 原文没超限（0.6 MiB），一比一换成两个字符之后 1.2 MiB 才超——上限判的是结果，不是入参。
    const occurrences = 600_000
    const before = 'a'.repeat(occurrences)
    expect(Buffer.byteLength(before, 'utf8')).toBeLessThan(MAX_FILE_BYTES)
    expect(() =>
      nextFileState(state(before, before), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'a',
        newText: 'bb',
        expectedReplacements: occurrences,
      }),
    ).toThrow(`resulting file content exceeds ${MAX_FILE_BYTES} byte limit`)
  })

  it('文件不存在 → `file does not exist`', () => {
    expect(() =>
      nextFileState(state('gone', null), {
        type: 'replace',
        path: 'a.txt',
        oldText: 'g',
        newText: 'x',
      }),
    ).toThrow(/^file does not exist$/)
  })
})

describe('nextFileState · overwrite_file', () => {
  it('文件不存在时无需守卫，直接建', () => {
    expect(
      nextFileState(fresh, { type: 'overwrite_file', path: 'a.txt', content: 'new' }),
    ).toEqual(state(null, 'new'))
  })

  it('覆盖已存在文件必须先证明读过', () => {
    expect(() =>
      nextFileState(state('old', 'old'), {
        type: 'overwrite_file',
        path: 'a.txt',
        content: 'new',
      }),
    ).toThrow(/^oldContent or expectedContentHash is required when overwriting an existing file$/)
  })

  it('oldContent 对上 → 覆盖', () => {
    expect(
      nextFileState(state('old', 'old'), {
        type: 'overwrite_file',
        path: 'a.txt',
        content: 'new',
        oldContent: 'old',
      }),
    ).toEqual(state('old', 'new'))
  })

  it('expectedContentHash 对上 → 覆盖', () => {
    expect(
      nextFileState(state('old', 'old'), {
        type: 'overwrite_file',
        path: 'a.txt',
        content: 'new',
        expectedContentHash: hashOf('old'),
      }),
    ).toEqual(state('old', 'new'))
  })

  it('两个守卫都给 → 拒（不做「有一个对上就行」）', () => {
    expect(() =>
      nextFileState(state('old', 'old'), {
        type: 'overwrite_file',
        path: 'a.txt',
        content: 'new',
        oldContent: 'old',
        expectedContentHash: hashOf('old'),
      }),
    ).toThrow(/^pass either oldContent or expectedContentHash, not both$/)
  })

  it('批内被 delete 置空后再 overwrite：current 为 null，不要求守卫', () => {
    const deleted = nextFileState(state('old', 'old'), { type: 'delete_file', path: 'a.txt' })
    expect(
      nextFileState(deleted, { type: 'overwrite_file', path: 'a.txt', content: 'new' }),
    ).toEqual(state('old', 'new'))
  })
})

describe('nextFileState 不改传进来的状态', () => {
  it('抛错的分支与成功的分支都不动原对象', () => {
    const original = state('old', 'old', true)
    const snapshot = { ...original }
    expect(() =>
      nextFileState(original, { type: 'add_file', path: 'a.txt', content: 'x' }),
    ).toThrow()
    nextFileState(original, {
      type: 'overwrite_file',
      path: 'a.txt',
      content: 'new',
      oldContent: 'old',
      executable: false,
    } satisfies PatchOperation)
    expect(original).toEqual(snapshot)
  })
})
