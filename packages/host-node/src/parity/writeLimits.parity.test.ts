// 对拍驱动器：单次写入的大小上限、可逆预算与守卫（带 IO）
// ---------------------------------------------------------------------------
// 喂 fixtures/write-limits.json，对面是 Rust 的 workspace_write_pipeline_parity_tests.rs。
//
// 与 patchPipeline/changeBatchRevert 两组不同：`write_workspace_file` 只碰**一个**目标路径，
// 没有「写完之后树里多一个文件」这类穷举风险，所以本组不做整棵树扫描，只在
// `expected.fileContent` 有值时读那一个目标文件——`null` 表示这条路径不该存在（按设计拒绝的
// 写入必须真的什么都没落盘）。
//
// 断言两段：
//   1. 回执 JSON 逐字段相同（键的有无算差异，见 parityFixtures.testHarness.ts 的口径说明）。
//   2. 可选的目标文件内容，用来证明「被拒的写入没有留下任何东西」与「成功的写入落的是解码后的
//      字节」（这条专门盯 base64 场景：回执里的 bytesWritten 对，不代表磁盘上的字节也对）。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeWorkspaceFile } from '../workspace/write/pipeline'
import { createTempWorkspace } from '../workspace/common/tempWorkspace.testHarness'
import { loadParityFixture, toComparableJson } from './parityFixtures.testHarness'
import { seedWorkspaceTree } from './workspaceTree.testHarness'
import type { WriteWorkspaceFileRequest } from '../workspace/write/pipeline'
import type { WorkspaceTree } from './workspaceTree.testHarness'

interface WriteLimitsCase {
  name: string
  source?: string
  initialFiles: WorkspaceTree
  request: Omit<WriteWorkspaceFileRequest, 'workspaceRoot'>
  expected: {
    result: unknown
    /** 目标文件跑完之后的内容；`null` = 这个路径不该存在。 */
    fileContent: string | null
  }
}

const fixture = loadParityFixture<WriteLimitsCase>('write-limits.json')
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
      const journal = join(workspace.base, 'journal')
      await seedWorkspaceTree(workspace.root, testCase.initialFiles)

      const result = await writeWorkspaceFile(
        { ...testCase.request, workspaceRoot: workspace.root },
        journal,
      )

      expect(toComparableJson(result)).toStrictEqual(testCase.expected.result)
      expect(await readTargetFile(workspace.root, testCase.request.path)).toBe(
        testCase.expected.fileContent,
      )
    })
  }
})

/** 目标路径不存在（或不是文件）时给 `null`——刻意不走 core 的读取函数，见 journalEntry.testHarness.ts 同款理由。 */
async function readTargetFile(root: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(root, relativePath), 'utf8')
  } catch {
    return null
  }
}
