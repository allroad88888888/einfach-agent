// 测试脚手架：一次性 workspace + 日志目录，以及「登记一条已应用的账」这件常做的事
// ---------------------------------------------------------------------------
// 形状对齐 Rust 侧的 `workspace_change_journal_test_support.rs`（`roots()` / `context()`），
// 底座复用 common 的 `createTempWorkspace`（它已经 realpath 过——macOS 的 `/var` 是软链，
// 不先解开的话每条 confinement 断言都会因为与被测逻辑无关的理由通过或失败）。
//
// `applyChangeSet` 把「登记 + 标记 applied」并成一步，是因为**回滚只认 applied/prepared 的账**，
// 而测试里几乎每条账都得走完这两步；分开写会让每个用例多两行噪音，也更容易漏掉第二步——漏掉时
// 回滚照样成功（`prepared` 不是 `reverted`），于是测不出真正想测的东西。

import { join } from 'node:path'
import { createTempWorkspace } from '../common/tempWorkspace.testHarness'
import { markChangeApplied, prepareChangeSet } from './prepare'
import type { ChangeFileInput, WorkspaceChangeContext } from './types'

export interface ChangeJournalFixture {
  /** workspace root（已 canonicalize）。 */
  root: string
  /** 日志目录，**尚不存在**——登记要能自己把它建出来。 */
  journal: string
  cleanup: () => Promise<void>
}

export async function createChangeJournalFixture(): Promise<ChangeJournalFixture> {
  const workspace = await createTempWorkspace()
  return {
    root: workspace.root,
    journal: join(workspace.base, 'journal'),
    cleanup: workspace.cleanup,
  }
}

export function changeContext(changeId: string): WorkspaceChangeContext {
  return { changeId, sessionId: 'session', runId: 'run', toolCallId: 'call' }
}

/** 登记一条整文件改写的账并标记为 applied——回滚测试里绝大多数账都是这种。 */
export async function applyChangeSet(
  fixture: ChangeJournalFixture,
  changeId: string,
  files: readonly ChangeFileInput[],
): Promise<void> {
  await prepareChangeSet(fixture.journal, changeContext(changeId), fixture.root, files)
  await markChangeApplied(fixture.journal, changeId)
}
