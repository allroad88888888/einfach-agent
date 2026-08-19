// 对拍驱动器：变更日志的批量回滚（带 IO）
// ---------------------------------------------------------------------------
// 喂 fixtures/change-batch-revert.json，对面是 Rust 的
// apps/desktop/src/workspace_change_journal_batch_parity_tests.rs（已随 T1 删除）。
//
// 驱动器直接调**批量**入口 `revertChangeSets`，不经命令层「一条走单条、多条走批量」的分流——
// fixture 抽自 workspace_change_journal_batch_tests.rs，测的就是批量那条路。
//
// 【账本按数组顺序登记，于是数组顺序 = createdAt 升序】批量执行的顺序由 `createdAt` 决定而不是
// 调用方传的 id 顺序，所以「登记顺序」是 fixture 的一部分：`changeSets[]` 的先后就是账本的先后，
// `revert.changeSetIds` 才是调用方的说法。两者故意可以不一致（有一例正是拿它当被测对象）。

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markChangeApplied, prepareChangeSet } from '../workspace/change/prepare'
import { revertChangeSets } from '../workspace/change/revertChangeSets'
import { updateStatus } from '../workspace/change/entryStore'
import { createTempWorkspace } from '../workspace/common/tempWorkspace.testHarness'
import { loadParityFixture, toComparableJson } from './parityFixtures.testHarness'
import { readJournalEntryStatus } from './journalEntry.testHarness'
import { readWorkspaceTree, seedWorkspaceTree } from './workspaceTree.testHarness'
import type { ChangeFileInput, ChangeStatus } from '../workspace/change/types'
import type { WorkspaceTree } from './workspaceTree.testHarness'

interface SeededChangeSet {
  id: string
  status: ChangeStatus
  files: ChangeFileInput[]
}

interface BatchRevertCase {
  name: string
  source?: string
  initialFiles: WorkspaceTree
  changeSets: SeededChangeSet[]
  revert: { changeSetIds: string[]; dryRun: boolean }
  expected: {
    result: unknown
    files: WorkspaceTree
    entries: Record<string, ChangeStatus>
  }
}

const fixture = loadParityFixture<BatchRevertCase>('change-batch-revert.json')
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

      for (const changeSet of testCase.changeSets) {
        await prepareChangeSet(
          journal,
          {
            changeId: changeSet.id,
            sessionId: 'session',
            runId: 'run',
            toolCallId: 'call',
          },
          workspace.root,
          changeSet.files,
        )
        // 登记出来的是 `prepared`；要 `applied` 走正规入口，要 `reverted` 只能直接改状态
        // （真跑一次回滚会顺带改动磁盘，那就不是「初始条件」了）。
        if (changeSet.status === 'applied') await markChangeApplied(journal, changeSet.id)
        if (changeSet.status === 'reverted') await updateStatus(journal, changeSet.id, 'reverted')
      }

      const result = await revertChangeSets(
        journal,
        testCase.revert.changeSetIds,
        testCase.revert.dryRun,
        workspace.root,
      )

      expect(toComparableJson(result)).toStrictEqual(testCase.expected.result)
      expect(await readWorkspaceTree(workspace.root)).toStrictEqual(testCase.expected.files)

      for (const [changeId, status] of Object.entries(testCase.expected.entries)) {
        expect(await readJournalEntryStatus(journal, changeId), `条目 ${changeId}`).toBe(status)
      }
    })
  }
})
