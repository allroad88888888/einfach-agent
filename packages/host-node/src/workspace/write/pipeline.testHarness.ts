// 测试脚手架：一次性 workspace + 日志目录，外加「跑一次写入」这件每个用例都要做的事
// ---------------------------------------------------------------------------
// 形状对齐 Rust 侧的 `workspace_write_test_support.rs`（`unique_workspace()` / `root_arg()`），
// 底座复用 common 的 `createTempWorkspace`（它已经 realpath 过——macOS 的 `/var` 是软链，不先
// 解开的话每条路径断言都会因为与被测逻辑无关的理由通过或失败）。
//
// `write()` 恒把 `workspaceRoot` 填成这次的临时根：**流水线不传 root 时会去跑 git rev-parse**，
// 那会让测试落到本仓库的真实工作区上——第一个写用例就会往仓库里写文件。

import { join } from 'node:path'
import { createTempWorkspace } from '../common/tempWorkspace.testHarness'
import { writeWorkspaceFile } from './pipeline'
import type { WriteWorkspaceFileRequest } from './pipeline'
import type { WorkspaceWriteResult } from './result'

export interface WriteFixture {
  /** workspace root（已 canonicalize）。 */
  root: string
  /** 变更日志目录，**尚不存在**——登记要能自己把它建出来。 */
  journal: string
  /** 跑一次写入。`workspaceRoot` 由脚手架填，用例给别的字段。 */
  write: (request: WriteRequest) => Promise<WorkspaceWriteResult>
  cleanup: () => Promise<void>
}

export type WriteRequest = Omit<WriteWorkspaceFileRequest, 'workspaceRoot'>

export async function createWriteFixture(): Promise<WriteFixture> {
  const workspace = await createTempWorkspace()
  const journal = join(workspace.base, 'journal')
  return {
    root: workspace.root,
    journal,
    write: (request) => writeWorkspaceFile({ ...request, workspaceRoot: workspace.root }, journal),
    cleanup: workspace.cleanup,
  }
}
