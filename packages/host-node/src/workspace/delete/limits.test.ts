import { describe, expect, it } from 'vitest'
import { MAX_BYTES, MAX_ENTRIES, exceedsDeleteBudget, tooLargeMessage } from './limits'

describe('可恢复删除的体量预算', () => {
  it('两个常量与 Rust 侧逐字一致', () => {
    // workspace_delete.rs: `const MAX_ENTRIES: u64 = 20_000;` / `const MAX_BYTES: u64 = 512 * 1024 * 1024;`
    expect(MAX_ENTRIES).toBe(20000)
    expect(MAX_BYTES).toBe(536870912)
  })

  it('边界是 `>`：恰好等于上限仍然放行', () => {
    expect(exceedsDeleteBudget(MAX_ENTRIES, MAX_BYTES)).toBe(false)
    expect(exceedsDeleteBudget(MAX_ENTRIES + 1, 0)).toBe(true)
    expect(exceedsDeleteBudget(0, MAX_BYTES + 1)).toBe(true)
  })

  it('两个维度各自独立，任一越界即拒', () => {
    expect(exceedsDeleteBudget(MAX_ENTRIES + 1, MAX_BYTES + 1)).toBe(true)
    expect(exceedsDeleteBudget(1, 1)).toBe(false)
  })

  it('文案内联两个数字，没有千分位分隔符', () => {
    expect(tooLargeMessage()).toBe(
      'path is too large for recoverable delete (limit: 20000 entries or 536870912 bytes)',
    )
  })
})
