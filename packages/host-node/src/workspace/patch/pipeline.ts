// 补丁主流程：暂存 → 拒绝汇总 → 预留账 → 落盘 → 收尾
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_pipeline.rs 的
// `apply_workspace_patch_blocking_with_journal`。本文件只做**编排**：每一步的规则各住一处
// （operation / path / stage / limits / commit，changeSummary 现住 `../common`），这里负责把它们
// 按 Rust 的顺序串起来。
//
// ═══ 「全部成功才落盘，任一失败整体不写」在这条链上是怎么兑现的 ═══
//   1. 逐条暂存。失败的记一条 `rejected[]` 并**继续暂存后面的**——Rust 是全部试完再汇总，模型
//      因此一次就能看到所有问题，而不是修一条报一条。暂存全程只改内存表，磁盘一个字不动。
//   2. `rejected` 非空 → 直接返回 `ok: false`，**根本不进落盘那步**。所以「整体不写」不是靠回滚
//      实现的，是靠还没开始写。这条性质有测试盯着（pipeline.test.ts 的"任一失败整体不写"）。
//   3. 全通过才算净变化路径（`initial !== current`）、才记账、才落盘。中途失败由 commit.ts 逆序还原。
//
// ═══ 记账必须在落盘之前 ═══
// `prepareChangeSet` 把「原来长什么样」写进变更日志，**然后**才动文件；反过来的话崩溃窗口里就是
// 「改动已发生、日志没有」，那次改动永久撤不回来。落盘失败则 `discardPreparedChange` 把那条尚未
// 生效的账丢掉——留着只是一条孤儿账，而漏掉丢弃会让 revert 去还原一次根本没发生的改动。
//
// ═══ 没有搬 Rust 的 perf 日志 ═══
// Rust 侧每个阶段都有一行 `log::info!(target: "web_agent::perf", ...)`，Node 宿主还没有对应的出口
// （与 change 域 `entryStore.ts` 的裁决一致）。`diagnosticOperationId` 因此只是被收下，不参与任何
// 行为——留着入参是为了 core 那边 `toTauriInput` 恒会传它时不被当成非法参数。

import { changedPaths, stageOperation } from './stage'
import { commitChanges } from './commit'
import { computeChangeSummary } from '../common'
import { patchDisplayPath } from './path'
import { readOptionalTextFile } from './fs'
import { discardPreparedChange, markChangeApplied, prepareChangeSet } from '../change/prepare'
import { resolveWorkspaceRoot } from '../common/resolveWorkspaceRoot'
import type { ChangeFileInput, WorkspaceChangeContext } from '../change/types'
import type { PatchFileChange, RejectedOperation, WorkspacePatchResult } from './result'
import type { PatchOperation, StagedFiles } from './types'

/** 记账的去处。整个可选：不带 `change_context` 的补丁就是一次不可回滚的直接写。 */
export interface PatchJournalTarget {
  directory: string
  context: WorkspaceChangeContext
}

export interface ApplyPatchRequest {
  operations: readonly PatchOperation[]
  dryRun: boolean
  workspaceRoot?: string
  journal?: PatchJournalTarget
}

export async function applyPatch(request: ApplyPatchRequest): Promise<WorkspacePatchResult> {
  const root = await resolveWorkspaceRoot(request.workspaceRoot)
  const files: StagedFiles = new Map()
  const rejected: RejectedOperation[] = []

  for (const [index, operation] of request.operations.entries()) {
    try {
      await stageOperation(root, files, operation, readOptionalTextFile)
    } catch (error) {
      rejected.push({
        index,
        operation: operation.type,
        path: operation.path,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      changedFiles: [],
      changes: [],
      rejected,
      dryRun: request.dryRun,
      wouldChange: false,
      summary: `rejected ${rejected.length} operation(s); no files changed`,
      changeSet: null,
    }
  }

  const paths = changedPaths(root, files)
  const changedFiles = paths.map((path) => patchDisplayPath(root, path))
  const changes = paths.map((path) => describeChange(root, path, files))

  // dry run 与「一个文件都没净变化」都不记账：前者什么都没发生，后者没有可撤销的东西。
  const shouldApply = !request.dryRun && paths.length > 0
  const prepared =
    shouldApply && request.journal
      ? await prepareChangeSet(
          request.journal.directory,
          request.journal.context,
          root,
          journalInputs(root, paths, files),
        )
      : null

  if (!request.dryRun) {
    try {
      await commitChanges(root, paths, files)
    } catch (error) {
      if (prepared && request.journal) {
        await discardPreparedChange(request.journal.directory, prepared.id)
      }
      throw error
    }
  }

  if (prepared && request.journal) {
    // 标记失败**不让整条命令失败**：文件已经改完了，这时报错会让调用方以为改动没发生。留下的是
    // 一条停在 `prepared` 的账，revert 照样认得（照搬 Rust 的 `log::warn!` + 继续）。
    await markChangeApplied(request.journal.directory, prepared.id).catch(() => {})
  }

  return {
    ok: true,
    changedFiles,
    changes,
    rejected,
    dryRun: request.dryRun,
    wouldChange: changedFiles.length > 0,
    summary: request.dryRun
      ? `dry run: ${changedFiles.length} file(s) would change`
      : `applied patch: ${changedFiles.length} file(s) changed`,
    changeSet: prepared,
  }
}

/**
 * 一个净变化路径的对外描述。`created` / `deleted` 都由 `initial` 与 `current` 判，不看磁盘。
 *
 * **一处有意的偏离**：`paths` 就是从 `files` 里挑出来的，查不到是构造上不可能的事；Rust 用
 * `filter_map` + `?` 在那种情况下**静默跳过**这个文件，本文件抛错。静默跳过的后果是这个文件照样
 * 被落盘、却不出现在 `changedFiles` 也不进变更日志——一次撤不回来的改动，且不报错。同样的判断
 * 在 `journalInputs` 里再来一次。
 */
function describeChange(root: string, path: string, files: StagedFiles): PatchFileChange {
  const state = files.get(path)
  if (state === undefined) throw new Error(`missing staged state for \`${path}\``)
  const change: PatchFileChange = {
    path: patchDisplayPath(root, path),
    created: state.initial === null && state.current !== null,
    deleted: state.current === null,
  }
  // 删除没有 after 可 diff，此时整个键不出现（Rust 的 `Option::map` + skip_serializing_if）。
  if (state.current !== null) {
    change.changeSummary = computeChangeSummary(state.initial, state.current)
  }
  return change
}

/** 记进变更日志的是**展示路径**与改前/改后两份完整文本——回滚只认这份记录。 */
function journalInputs(
  root: string,
  paths: readonly string[],
  files: StagedFiles,
): ChangeFileInput[] {
  return paths.map((path) => {
    const state = files.get(path)
    if (state === undefined) throw new Error(`missing staged state for \`${path}\``)
    return { path: patchDisplayPath(root, path), before: state.initial, after: state.current }
  })
}
