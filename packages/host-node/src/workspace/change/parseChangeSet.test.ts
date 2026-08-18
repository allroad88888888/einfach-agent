import { describe, expect, it } from 'vitest'
import { buildChangeSet } from './buildChangeSet'
import { parseChangeSet } from './parseChangeSet'

const entry = buildChangeSet({
  context: { changeId: 'chg-1', sessionId: 's', runId: 'r', toolCallId: 't' },
  workspaceRoot: '/ws',
  createdAt: 1_700_000_000_000_000_000,
  files: [{ path: 'a.txt', before: 'old', after: null }],
})

/** 磁盘上那份 JSON 的解析结果——测试要走的正是 entryStore 走的那条路。 */
function encoded(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>
}

describe('parseChangeSet', () => {
  it('自己写出去的条目能原样读回来', () => {
    expect(parseChangeSet(encoded())).toEqual(entry)
  })

  it('忽略未知键（Rust 侧没有 deny_unknown_fields）', () => {
    // 收严会拒掉将来版本的桌面端写的条目，那正是「日志静默分家」的另一种形态。
    expect(parseChangeSet({ ...encoded(), somethingNew: 1 })).toEqual(entry)
  })

  it('四个账目数组缺失时按空数组处理（#[serde(default)]）', () => {
    const partial = encoded()
    delete partial.files
    delete partial.movedPaths
    delete partial.createdPaths
    delete partial.relocatedPaths
    expect(parseChangeSet(partial)).toMatchObject({
      files: [],
      movedPaths: [],
      createdPaths: [],
      relocatedPaths: [],
    })
  })

  it('快照的 hash/content 缺失时按 null 处理（serde 对 Option 字段的特判）', () => {
    // 这一条**不是**「缺字段就随便放行」，只对 Option 字段成立，判据见 parseChangeSet.ts 文件头。
    const source = encoded()
    const files = source.files as Array<Record<string, Record<string, unknown>>>
    delete files[0]!.before!.hash
    delete files[0]!.before!.content
    expect(parseChangeSet(source).files[0]?.before).toEqual({
      exists: true,
      hash: null,
      content: null,
    })
  })

  it.each([
    ['id', 'missing field `id`'],
    ['workspaceRoot', 'missing field `workspaceRoot`'],
    ['createdAt', 'missing field `createdAt`'],
  ])('必需字段 %s 缺失即拒', (key, message) => {
    const source = encoded()
    delete source[key]
    expect(() => parseChangeSet(source)).toThrow(message)
  })

  it('status 不在三个取值内即拒', () => {
    expect(() => parseChangeSet({ ...encoded(), status: 'half-applied' })).toThrow(
      'unknown value for field `status`',
    )
  })

  it('createdAt 必须是非负整数', () => {
    expect(() => parseChangeSet({ ...encoded(), createdAt: -1 })).toThrow('createdAt')
    expect(() => parseChangeSet({ ...encoded(), createdAt: 1.5 })).toThrow('createdAt')
    expect(() => parseChangeSet({ ...encoded(), createdAt: '1' })).toThrow('createdAt')
  })

  it('账目数组给了非数组即拒，而不是当作空', () => {
    // 当作空的话，一条坏条目会被读成「这次改动什么都没改」，回滚于是静默地什么都不做。
    expect(() => parseChangeSet({ ...encoded(), files: {} })).toThrow(
      'invalid type for field `files`',
    )
  })

  it('嵌套字段的错误指得出位置', () => {
    const source = encoded()
    const files = source.files as Array<Record<string, Record<string, unknown>>>
    files[0]!.before!.exists = 'yes'
    expect(() => parseChangeSet(source)).toThrow('files[0].before.exists')
  })

  it.each([null, 'text', 42, ['a']])('顶层不是对象即拒：%s', (value) => {
    expect(() => parseChangeSet(value)).toThrow('invalid type for `change set`')
  })
})
