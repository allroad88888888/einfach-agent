import { describe, expect, it } from 'vitest'
import { computeChangeSummary } from './changeSummary'

describe('computeChangeSummary', () => {
  it('单行改动：只报中间那段，头尾相同的行不进 diff', () => {
    const summary = computeChangeSummary('keep\nold\ntail\n', 'keep\nnew\ntail\n')

    expect(summary.linesAdded).toBe(1)
    expect(summary.linesRemoved).toBe(1)
    expect(summary.beforeLines).toBe(3)
    expect(summary.afterLines).toBe(3)
    // 头部掐掉 1 行，所以 hunk 从第 2 行开始、两侧各 1 行。
    expect(summary.diff).toBe('@@ -2,1 +2,1 @@\n-old\n+new')
    expect(summary.diffTruncated).toBe(false)
    expect(summary.approximate).toBe(false)
  })

  it('新建文件：before 为 null 当零行处理', () => {
    const summary = computeChangeSummary(null, 'one\ntwo\n')

    expect(summary.linesAdded).toBe(2)
    expect(summary.linesRemoved).toBe(0)
    expect(summary.beforeLines).toBe(0)
    expect(summary.afterLines).toBe(2)
    expect(summary.diff).toBe('@@ -1,0 +1,2 @@\n+one\n+two')
  })

  it('内容没变：不给 diff 键，而不是给一个空 diff', () => {
    const summary = computeChangeSummary('same\n', 'same\n')

    expect(summary).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      beforeLines: 1,
      afterLines: 1,
      diffTruncated: false,
      approximate: false,
    })
    // core 的 normalizeWriteChangeSummary 只在 diff 是非空字符串时才带上它；这里连键都不该有。
    expect('diff' in summary).toBe(false)
  })

  it('超过 60 行的 diff 被截断并附上还剩多少行', () => {
    const before = Array.from({ length: 40 }, (_, index) => `old-${index}`).join('\n')
    const after = Array.from({ length: 40 }, (_, index) => `new-${index}`).join('\n')

    const summary = computeChangeSummary(before, after)

    expect(summary.linesAdded).toBe(40)
    expect(summary.linesRemoved).toBe(40)
    expect(summary.diffTruncated).toBe(true)
    const lines = summary.diff?.split('\n') ?? []
    // 1 行 hunk 头 + 60 行 diff + 1 行提示。
    expect(lines).toHaveLength(62)
    expect(lines[61]).toBe('... 20 more diff lines')
  })

  it('LCS 表放不下时退化成整块替换并标记 approximate', () => {
    // 预算是 800×800；两侧各 801 行且逐行不同，掐头去尾之后仍然超预算。
    const before = Array.from({ length: 801 }, (_, index) => `a-${index}`).join('\n')
    const after = Array.from({ length: 801 }, (_, index) => `b-${index}`).join('\n')

    const summary = computeChangeSummary(before, after)

    expect(summary.approximate).toBe(true)
    expect(summary.linesRemoved).toBe(801)
    expect(summary.linesAdded).toBe(801)
    // 整块替换是「先全删再全加」，所以截断前的头几行一定都是删。
    expect(summary.diff?.split('\n')[1]).toBe('-a-0')
  })

  it('清空文件：after 为空串时算零行', () => {
    const summary = computeChangeSummary('gone\n', '')

    expect(summary.beforeLines).toBe(1)
    expect(summary.afterLines).toBe(0)
    expect(summary.linesRemoved).toBe(1)
    expect(summary.linesAdded).toBe(0)
  })
})
