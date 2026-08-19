// 对拍驱动器：字节/行读取的容量上限、越界与截断（带 IO）
// ---------------------------------------------------------------------------
// 喂 fixtures/read-limits.json，对面是 Rust 的 workspace_read_limits_parity_tests.rs。
//
// 走的是 `read_workspace_file` 的**顶层分派**（`readWorkspaceFile(args)`），不是直接调字节或
// 行两个子实现——分派本身（两个行参数都缺席才走字节模式、offset 与 startLine 冲突判定）也是
// 要盯的行为，见 fixtures/README.md「新增一组要改哪几个文件」旁边补的那条说明。
//
// **读不改磁盘**，所以本组不做 patch-pipeline / write-limits 那种「跑完之后文件/目标路径变成
// 什么样」的收尾断言，只比结果或错误文案。
//
// 【错误文案里带 resolved 绝对路径的用例一律不进本组】`display_path` 在越界类错误里报的是
// canonicalize 之后的绝对路径，而两侧的临时 workspace 目录命名各不相同（Rust 用
// `web_agent_parity_<pid>_<seq>`，Node 用 `mkdtemp` 的随机后缀），没有任何机制能让它们生成同一
// 个字符串。`offset 超出文件大小`、`startLine 超出总行数` 这两类拒绝正是如此，本组不收，
// 详见 fixtures/README.md 的比对口径新增的第三条豁免。

import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceFile } from '../workspace/read/linesDispatch'
import { createTempWorkspace } from '../workspace/common/tempWorkspace.testHarness'
import { loadParityFixture, toComparableJson } from './parityFixtures.testHarness'
import { seedWorkspaceTree } from './workspaceTree.testHarness'
import type { WorkspaceTree } from './workspaceTree.testHarness'

interface ReadLimitsCase {
  name: string
  source?: string
  initialFiles: WorkspaceTree
  /** `read_workspace_file` 的顶层入参，键与线上一致（snake_case）。 */
  request: {
    path: string
    max_bytes?: number
    offset?: number
    start_line?: number
    line_count?: number
  }
  /** 恰好给一个：`result`（成功）或 `error`（拒绝文案，逐字比较）。 */
  expected: { result: unknown } | { error: string }
}

const fixture = loadParityFixture<ReadLimitsCase>('read-limits.json')
let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

describe(`对拍 · ${fixture.target}`, () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, async () => {
      const workspace = await createTempWorkspace()
      cleanup = workspace.cleanup
      await seedWorkspaceTree(workspace.root, testCase.initialFiles)

      const args = { ...testCase.request, workspace_root: workspace.root }

      if ('error' in testCase.expected) {
        // 逐字比较，不用 `toThrow` 的子串匹配——两个宿主对同一次拒绝必须说同一句完整的话，
        // 子串匹配会放过「Node 在文案后面多缀了半句」这类分岔。同款口径见
        // parityFixtures.testHarness.ts 的 captureFailure（那份是同步版，这里是异步调用）。
        const message = await readWorkspaceFile(args).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        expect(message).toBe(testCase.expected.error)
        return
      }
      const result = await readWorkspaceFile(args)
      expect(toComparableJson(result)).toStrictEqual(testCase.expected.result)
    })
  }
})
