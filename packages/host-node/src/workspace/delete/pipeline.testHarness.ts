// 测试脚手架：一次性 workspace + 日志目录，外加「跑一次删除」这件每个用例都要做的事
// ---------------------------------------------------------------------------
// 形状对齐 Rust 侧 `workspace_delete.rs` 测试模块里的 `roots()` / `context()`，底座复用 common 的
// `createTempWorkspace`（它已经 realpath 过——macOS 的 `/var` 是软链，不先解开的话每条路径断言
// 都会因为与被测逻辑无关的理由通过或失败）。
//
// `remove()` 恒把 `workspaceRoot` 填成这次的临时根：**流水线不传 root 时会去跑 git rev-parse**，
// 那会让测试落到本仓库的真实工作区上——而这是**删除**，第一个用例就会删掉仓库里的文件。

import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from '../common/tempWorkspace.testHarness'
import { deleteWorkspacePath } from './pipeline'
import type { DeleteWorkspacePathRequest } from './pipeline'
import type { WorkspaceChangeContext, WorkspaceChangeSet } from '../change/types'
import type { WorkspaceDeleteResult } from './result'

export interface DeleteFixture {
  /** workspace root（已 canonicalize）。 */
  root: string
  /** workspace root 的父目录——「根外」素材放这里。 */
  base: string
  /** 变更日志目录，**尚不存在**——登记要能自己把它建出来。 */
  journal: string
  /** 跑一次删除。`workspaceRoot` 由脚手架填，用例给别的字段。 */
  remove: (request: DeleteRequest) => Promise<WorkspaceDeleteResult>
  cleanup: () => Promise<void>
}

export type DeleteRequest = Omit<DeleteWorkspacePathRequest, 'workspaceRoot'>

export async function createDeleteFixture(): Promise<DeleteFixture> {
  const workspace = await createTempWorkspace()
  const journal = join(workspace.base, 'journal')
  return {
    root: workspace.root,
    base: workspace.base,
    journal,
    remove: (request) =>
      deleteWorkspacePath({ ...request, workspaceRoot: workspace.root }, journal),
    cleanup: workspace.cleanup,
  }
}

export function deleteContext(changeId: string): WorkspaceChangeContext {
  return { changeId, sessionId: 'session', runId: 'run', toolCallId: 'call' }
}

/**
 * 日志目录里现在有哪些文件（已排序）。目录不存在时给空数组——「一条账都没记」与「日志目录还
 * 没被建出来」在断言层面是同一件事：都表示这次删除在碰盘之前就被拒了。
 */
export async function journalEntries(fixture: DeleteFixture): Promise<string[]> {
  return (await readdir(fixture.journal).catch(() => [])).sort()
}

export async function readEntry(
  fixture: DeleteFixture,
  changeId: string,
): Promise<WorkspaceChangeSet> {
  const raw = await readFile(join(fixture.journal, `${changeId}.json`), 'utf8')
  return JSON.parse(raw) as WorkspaceChangeSet
}

/** **不跟随**软链的存在性判定——测软链用例时跟随了就永远看不见那条链本身。 */
export async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}
