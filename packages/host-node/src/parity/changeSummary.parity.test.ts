// 对拍驱动器：改动摘要（纯函数）
// ---------------------------------------------------------------------------
// 喂 fixtures/change-summary.json，对面是 Rust 的
// apps/desktop/src/workspace_common_summary_parity_tests.rs（已随 T1 删除）。
//
// 这一组是**唯一一组 Rust 侧原本零测试**的：`compute_change_summary` 住在 workspace_common.rs 里，
// 那个文件没有 `mod tests`。所以本组既是对拍，也是它在 Rust 侧的第一份测试。

import { describe, expect, it } from 'vitest'
import { computeChangeSummary } from '../workspace/common'
import { loadParityFixture, toComparableJson } from './parityFixtures.testHarness'

interface ChangeSummaryCase {
  name: string
  /** `null` = 这个文件是新建的（Rust 那边是 `Option<&str>` 的 `None`）。 */
  before: string | null
  after: string
  /** `FileChangeSummary` 的完整 JSON；无变动时**没有 `diff` 这个键**。 */
  expected: unknown
}

const fixture = loadParityFixture<ChangeSummaryCase>('change-summary.json')

describe(`对拍 · ${fixture.target}`, () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const summary = computeChangeSummary(testCase.before, testCase.after)
      expect(toComparableJson(summary)).toStrictEqual(testCase.expected)
    })
  }
})
