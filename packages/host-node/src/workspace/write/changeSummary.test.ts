import { describe, expect, it } from 'vitest'
import { computeChangeSummary } from './changeSummary'

describe('computeChangeSummary', () => {
  it('只报变动区间，未改动的头尾不进 diff', () => {
    // 对应 Rust 的 change_summary_reports_the_edited_region_only。
    const summary = computeChangeSummary('a\nb\nc\nd\ne\n', 'a\nb\nCHANGED\nd\ne\n')
    expect(summary.linesAdded).toBe(1)
    expect(summary.linesRemoved).toBe(1)
    expect(summary.beforeLines).toBe(5)
    expect(summary.afterLines).toBe(5)
    expect(summary.approximate).toBe(false)
    expect(summary.diffTruncated).toBe(false)
    expect(summary.diff).toContain('-c')
    expect(summary.diff).toContain('+CHANGED')
    expect(summary.diff).not.toContain('+a')
    // hunk 头的起始行号 = 裁掉的头部长度 + 1。
    expect(summary.diff?.startsWith('@@ -3,1 +3,1 @@')).toBe(true)
  })

  it('新建文件的每一行都算新增', () => {
    const summary = computeChangeSummary(null, 'one\ntwo\n')
    expect(summary.linesAdded).toBe(2)
    expect(summary.linesRemoved).toBe(0)
    expect(summary.beforeLines).toBe(0)
    expect(summary.afterLines).toBe(2)
  })

  it('内容完全相同时没有 diff 键，而不是一个空 diff', () => {
    const summary = computeChangeSummary('same\n', 'same\n')
    expect(summary.linesAdded).toBe(0)
    expect(summary.linesRemoved).toBe(0)
    expect(summary.diff).toBeUndefined()
    expect('diff' in summary).toBe(false)
  })

  it('超出 LCS 预算时降级成整块替换并标记 approximate', () => {
    // 对应 Rust 的 oversized_edits_degrade_to_an_approximate_block_summary。
    const before = Array.from({ length: 1200 }, (_, index) => `before ${index}\n`).join('')
    const after = Array.from({ length: 1200 }, (_, index) => `after ${index}\n`).join('')
    const summary = computeChangeSummary(before, after)

    expect(summary.approximate).toBe(true)
    expect(summary.linesRemoved).toBe(1200)
    expect(summary.linesAdded).toBe(1200)
    expect(summary.diffTruncated).toBe(true)
    // 60 条编辑 + hunk 头 + 截断提示 = 62 行封顶。
    expect(summary.diff?.split('\n').length).toBeLessThanOrEqual(62)
    expect(summary.diff).toContain('more diff lines')
  })

  it('预算之内的大改动仍走最小 diff', () => {
    const before = Array.from({ length: 400 }, (_, index) => `line ${index}\n`).join('')
    const after = `${before}tail\n`
    const summary = computeChangeSummary(before, after)
    expect(summary.approximate).toBe(false)
    expect(summary.linesAdded).toBe(1)
    expect(summary.linesRemoved).toBe(0)
  })
})

describe('行的切法（等价 Rust 的 str::lines）', () => {
  it('末尾换行不额外产生一行', () => {
    expect(computeChangeSummary(null, 'a\nb\n').afterLines).toBe(2)
  })

  it('空文件是 0 行——`\'\'.split()` 的 1 段是 JS 直觉写错的地方', () => {
    expect(computeChangeSummary(null, '').afterLines).toBe(0)
  })

  it('末行没有换行符仍算一行', () => {
    expect(computeChangeSummary(null, 'a\nb').afterLines).toBe(2)
  })

  it('连续换行各自成行', () => {
    expect(computeChangeSummary(null, 'a\n\n').afterLines).toBe(2)
  })

  it('\\r\\n 的 \\r 被当作行结束符剥掉，所以两种换行风格的同一份内容零差异', () => {
    const summary = computeChangeSummary('a\r\nb\r\n', 'a\nb\n')
    expect(summary.linesAdded).toBe(0)
    expect(summary.linesRemoved).toBe(0)
  })

  it('末行结尾的 \\r 没有换行符跟着时属于内容，不剥', () => {
    // Rust 的 lines() 先 strip_suffix('\n')，失败就整段原样返回——所以 "a\r" 与 "a" 是两行不同的内容。
    const summary = computeChangeSummary('a\r', 'a')
    expect(summary.linesAdded).toBe(1)
    expect(summary.linesRemoved).toBe(1)
  })
})
