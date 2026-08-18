import { describe, expect, it } from 'vitest'
import { parsePatchOperation, parsePatchOperations } from './operation'

describe('parsePatchOperations · 判别值与字段名', () => {
  it('四个判别值是 snake_case，载荷字段是 camelCase', () => {
    // 这条命令最容易搞错的地方：`type` 的取值随 Rust 的 rename_all = "snake_case"，
    // 字段名却是逐个 #[serde(rename)] 出来的 camelCase，两层不同款。
    expect(
      parsePatchOperations([
        { type: 'add_file', path: 'a.txt', content: 'x', executable: true },
        {
          type: 'delete_file',
          path: 'b.txt',
          oldContent: 'old',
        },
        {
          type: 'replace',
          path: 'c.txt',
          oldText: 'a',
          newText: 'b',
          expectedReplacements: 2,
        },
        {
          type: 'overwrite_file',
          path: 'd.txt',
          content: 'x',
          expectedContentHash: 'sha256:abc',
          executable: false,
        },
      ]),
    ).toEqual([
      { type: 'add_file', path: 'a.txt', content: 'x', executable: true },
      { type: 'delete_file', path: 'b.txt', oldContent: 'old' },
      { type: 'replace', path: 'c.txt', oldText: 'a', newText: 'b', expectedReplacements: 2 },
      {
        type: 'overwrite_file',
        path: 'd.txt',
        content: 'x',
        expectedContentHash: 'sha256:abc',
        executable: false,
      },
    ])
  })

  it('没给的可选字段是「键不存在」，不是 undefined', () => {
    // 进程内注入与走 HTTP 两条路上键集合本来就不同，收窄之后必须一致。
    const [operation] = parsePatchOperations([
      { type: 'delete_file', path: 'b.txt', oldContent: undefined, expectedContentHash: null },
    ])
    expect(Object.keys(operation ?? {})).toEqual(['type', 'path'])
  })

  it('snake_case 的字段名不被接受（写错了要当场看见，不是静默丢弃）', () => {
    expect(() =>
      parsePatchOperations([{ type: 'replace', path: 'c.txt', old_text: 'a', new_text: 'b' }]),
    ).toThrow(/operations\[0\]\.oldText 必须是字符串/)
  })

  it('多余的键照 serde 的规矩忽略（Rust 没有 deny_unknown_fields）', () => {
    expect(
      parsePatchOperations([{ type: 'add_file', path: 'a.txt', content: 'x', extra: 1 }]),
    ).toEqual([{ type: 'add_file', path: 'a.txt', content: 'x' }])
  })
})

describe('parsePatchOperations · 拒绝路径', () => {
  it('operations 必须是数组', () => {
    expect(() => parsePatchOperations(undefined)).toThrow(/^operations 必须是数组$/)
    expect(() => parsePatchOperations({ 0: {} })).toThrow(/^operations 必须是数组$/)
  })

  it('元素必须是对象，且 type 必须是四个之一', () => {
    expect(() => parsePatchOperations(['add_file'])).toThrow(/^operations\[0\] 必须是对象$/)
    expect(() => parsePatchOperations([{ type: 'append_file', path: 'a' }])).toThrow(
      /^operations\[0\]\.type 必须是 add_file \/ delete_file \/ replace \/ overwrite_file 之一$/,
    )
    expect(() => parsePatchOperations([{ type: 'addFile', path: 'a' }])).toThrow(/\.type 必须是/)
  })

  it('错误文案带下标，指得出是第几条', () => {
    expect(() =>
      parsePatchOperations([
        { type: 'add_file', path: 'a.txt', content: 'x' },
        { type: 'add_file', path: 'b.txt' },
      ]),
    ).toThrow(/^operations\[1\]\.content 必须是字符串$/)
  })

  it('path 四个变体都是必填字符串', () => {
    for (const type of ['add_file', 'delete_file', 'replace', 'overwrite_file'] as const) {
      expect(() => parsePatchOperations([{ type, path: 42 }])).toThrow(
        /^operations\[0\]\.path 必须是字符串$/,
      )
    }
  })

  it('可选字段给了值就必须是对的类型', () => {
    expect(() =>
      parsePatchOperations([{ type: 'add_file', path: 'a', content: 'x', executable: 'yes' }]),
    ).toThrow(/^operations\[0\]\.executable 必须是布尔值$/)
    expect(() =>
      parsePatchOperations([{ type: 'delete_file', path: 'a', oldContent: 1 }]),
    ).toThrow(/^operations\[0\]\.oldContent 必须是字符串$/)
  })

  it('expectedReplacements 只收整数（Rust 那边是 i64，小数与数字字符串都被 serde 拒）', () => {
    for (const value of [1.5, '2', Number.NaN]) {
      expect(() =>
        parsePatchOperations([
          { type: 'replace', path: 'a', oldText: 'a', newText: 'b', expectedReplacements: value },
        ]),
      ).toThrow(/^operations\[0\]\.expectedReplacements 必须是整数$/)
    }
    // 负数与 0 在这里放行——「必须为正」是暂存规则那一层的判断，文案也不同。
    expect(() =>
      parsePatchOperations([
        { type: 'replace', path: 'a', oldText: 'a', newText: 'b', expectedReplacements: 0 },
      ]),
    ).not.toThrow()
  })

  it('单条解析可以自己带下标（流水线逐条收窄时用）', () => {
    expect(() => parsePatchOperation({ type: 'add_file', path: 'a' }, 7)).toThrow(
      /^operations\[7\]\.content 必须是字符串$/,
    )
  })
})
