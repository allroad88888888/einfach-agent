// 单条账的真正执行：四段还原，任一段失败就把已经做过的全部补回去
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_revert.rs:125-218。**只在非 dryRun 时被调用**。
//
// ═══ 为什么每一步都要再检查一次 ═══
// 预检（revertPlan.ts）与执行之间隔着若干次 IO，用户/编辑器/另一个 agent 完全可能在这个窗口里
// 改动同一个文件。所以写回之前**逐条重查**，而不是信任预检结论。这不是防御性编程的洁癖：预检
// 通过、执行覆盖，是「回滚吃掉用户刚写的东西」的唯一路径。
//
// ═══ 部分失败：绝不留下一半 ═══
// 「回滚报告说成功了但其实只回滚了一半」是这块最坏的失败模式。所以任一步失败都要把**已经做过
// 的每一步**按组倒序补回去，然后报告失败——最终状态与没回滚过一模一样，条目状态也仍是
// `applied`（**失败的账不会被标成 reverted**，下次还能重试）。
//
// 补偿的顺序是「按组、组内倒序」，与 Rust 的四段 `compensate*` 调用逐条一致，**不是**一个
// 统一的 LIFO 栈。实际形态上一条账只会有四类中的一类（prepare 的四个入口各填一类），所以两种
// 顺序不可区分；写成按组是为了在 diff 上与 Rust 对得上，而不是让人去证明它们等价。
//
// 补偿自身的失败一律吞掉（Rust 的 `let _ = ...`）：那时要报的是原始失败，补偿的第二个错误只会
// 盖掉病因。**代价要说清楚**：补偿也失败时，磁盘上留下的是一个中间态，而回执里只写着原始原因。
//
// ⚠️ **一处照搬的 Rust 缺口**：`readSnapshot` 在执行循环里失败（文件在预检之后变成了二进制或
// 非 UTF-8）时，Rust 是 `?` 直接向上抛，**不补偿**——已经还原过的前几个文件就停在还原后的样子，
// 而调用方收到的是一个异常而不是回执。窗口极窄（预检刚读过同一批文件），但它确实是「回滚了一半」
// 的一条真实路径。本卡照搬不单方面改，记在这里给 W16 对拍时判。

import { errorText } from '../common/errorText'
import { createdPayloadPath, payloadPath } from './entryPaths'
import { sameSnapshotState } from './fileSnapshot'
import { movePath } from './pathOpsMove'
import { symlinkExists } from './pathProbe'
import { readSnapshot, writeSnapshot } from './snapshotIo'
import { writeEntry } from './entryStore'
import { errorResult, restoredFilePaths, successResult } from './revertResult'
import type { RevertPlan } from './revertPlan'
import type { WorkspaceChangeSet, WorkspaceRevertResult } from './types'

/** 已经做完的步骤。补偿只认它——没记下来的一步等于没做过，重复补偿会把状态推到第三种样子。 */
interface RevertProgress {
  files: number[]
  moved: number[]
  created: Array<{ payload: string; path: string }>
  relocated: Array<{ source: string; destination: string }>
}

export async function executeRevert(
  directory: string,
  canonicalRoot: string,
  entry: WorkspaceChangeSet,
  plan: RevertPlan,
): Promise<WorkspaceRevertResult> {
  const progress: RevertProgress = { files: [], moved: [], created: [], relocated: [] }
  const rollback = async (status: 'conflict' | 'failed', message: string) => {
    await compensate(directory, canonicalRoot, entry, plan, progress)
    return errorResult(status, message)
  }

  for (const [index, file] of entry.files.entries()) {
    const path = plan.files[index]
    const current = await readSnapshot(path)
    if (!sameSnapshotState(current, file.after)) {
      return rollback('conflict', `file changed while reverting: ${file.path}`)
    }
    try {
      await writeSnapshot(canonicalRoot, path, file.before)
    } catch (error) {
      return rollback('failed', errorText(error))
    }
    progress.files.push(index)
  }

  const payload = payloadPath(directory, entry.id)
  for (const [index, path] of plan.moved.entries()) {
    if (await symlinkExists(path)) {
      const recorded = entry.movedPaths[index].path
      return rollback('conflict', `deleted path was recreated while reverting: ${recorded}`)
    }
    try {
      await movePath(payload, path)
    } catch (error) {
      return rollback('failed', errorText(error))
    }
    progress.moved.push(index)
  }

  for (const [index, path] of plan.created.entries()) {
    const itemPayload = createdPayloadPath(directory, entry.id, index)
    try {
      await movePath(path, itemPayload)
    } catch (error) {
      return rollback('failed', errorText(error))
    }
    progress.created.push({ payload: itemPayload, path })
  }

  for (const { source, destination } of plan.relocated) {
    try {
      await movePath(destination, source)
    } catch (error) {
      return rollback('failed', errorText(error))
    }
    progress.relocated.push({ source, destination })
  }

  // 状态最后才落盘：它是「这条账已经回滚过了」的唯一记号，写早了而后面失败，重试就会被
  // `already_reverted` 挡住，那才是真的回不来。
  try {
    await writeEntry(directory, { ...entry, status: 'reverted' })
  } catch (error) {
    return rollback('failed', errorText(error))
  }
  return successResult('reverted', restoredFilePaths(entry), [entry.id])
}

async function compensate(
  directory: string,
  canonicalRoot: string,
  entry: WorkspaceChangeSet,
  plan: RevertPlan,
  progress: RevertProgress,
): Promise<void> {
  for (const index of [...progress.files].reverse()) {
    await writeSnapshot(canonicalRoot, plan.files[index], entry.files[index].after).catch(() => {})
  }
  const payload = payloadPath(directory, entry.id)
  for (const index of [...progress.moved].reverse()) {
    await movePath(plan.moved[index], payload).catch(() => {})
  }
  for (const item of [...progress.created].reverse()) {
    await movePath(item.payload, item.path).catch(() => {})
  }
  for (const item of [...progress.relocated].reverse()) {
    await movePath(item.source, item.destination).catch(() => {})
  }
}
