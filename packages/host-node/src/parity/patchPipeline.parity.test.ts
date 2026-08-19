// 对拍驱动器：整条补丁流水线（带 IO）
// ---------------------------------------------------------------------------
// 喂 fixtures/patch-pipeline.json，对面是 Rust 的
// apps/desktop/src/workspace_patch_pipeline_parity_tests.rs。
//
// 每例各建一个临时 workspace：`<base>/workspace` 是 root，日志目录是它的**兄弟** `<base>/journal`
// ——不是 `<root>/.journal`，否则日志文件会混进 `expected.files` 的穷举里。
//
// 断言三段，缺一不可：
//   1. 回执 JSON 逐字段相同（键的有无算差异，见 parityFixtures.testHarness.ts 的口径说明）。
//   2. 落盘后的**整棵树**逐字节相同——多一个文件或少一个文件都算失败。
//   3. 可选的执行位与日志条目状态。执行位在非 unix 上跳过（Rust 的 `apply_executable_bit`
//      在那里是 no-op，两边都一样什么都不做，比它没有意义）。

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../workspace/patch/pipeline'
import { createTempWorkspace } from '../workspace/common/tempWorkspace.testHarness'
import { loadParityFixture, toComparableJson } from './parityFixtures.testHarness'
import { readJournalEntryStatus } from './journalEntry.testHarness'
import { readWorkspaceTree, seedWorkspaceTree } from './workspaceTree.testHarness'
import type { PatchOperation } from '../workspace/patch/types'
import type { WorkspaceChangeContext } from '../workspace/change/types'
import type { WorkspaceTree } from './workspaceTree.testHarness'

interface PipelineCase {
  name: string
  source?: string
  unixOnly?: boolean
  initialFiles: WorkspaceTree
  operations: PatchOperation[]
  dryRun: boolean
  changeContext?: WorkspaceChangeContext
  expected: {
    result: unknown
    files: WorkspaceTree
    executable?: Record<string, boolean>
    /** id → 跑完之后该条目的 status；值为 `null` = 该条目文件不该存在。 */
    journalEntries?: Record<string, string | null>
  }
}

const fixture = loadParityFixture<PipelineCase>('patch-pipeline.json')
const isUnix = process.platform !== 'win32'
let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

describe(`对拍 · ${fixture.target}`, () => {
  for (const testCase of fixture.cases) {
    const run = testCase.unixOnly === true && !isUnix ? it.skip : it
    run(testCase.name, async () => {
      const workspace = await createTempWorkspace()
      cleanup = workspace.cleanup
      const journal = join(workspace.base, 'journal')
      await seedWorkspaceTree(workspace.root, testCase.initialFiles)

      const result = await applyPatch({
        operations: testCase.operations,
        dryRun: testCase.dryRun,
        workspaceRoot: workspace.root,
        ...(testCase.changeContext === undefined
          ? {}
          : { journal: { directory: journal, context: testCase.changeContext } }),
      })

      expect(toComparableJson(result)).toStrictEqual(testCase.expected.result)
      expect(await readWorkspaceTree(workspace.root)).toStrictEqual(testCase.expected.files)

      if (isUnix && testCase.expected.executable !== undefined) {
        for (const [relativePath, executable] of Object.entries(testCase.expected.executable)) {
          const info = await stat(join(workspace.root, relativePath))
          // 只比「有没有执行位」，不比完整 mode：新建文件的基准权限跟 umask 走，两次运行都可能不同。
          expect((info.mode & 0o111) !== 0, `${relativePath} 的执行位`).toBe(executable)
        }
      }

      for (const [changeId, status] of Object.entries(testCase.expected.journalEntries ?? {})) {
        expect(await readJournalEntryStatus(journal, changeId), `条目 ${changeId}`).toBe(status)
      }
    })
  }
})
