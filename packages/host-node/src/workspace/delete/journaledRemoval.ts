// 记账 → 备份 → 真删 → 结账，中间任何一步失败都把世界推回原样
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_delete.rs 从 `prepare_deleted_path_change` 到
// `mark_change_applied` 的那一段。这是本卡的心脏：**删除是不可逆动作，账必须在动手之前记上**。
//
// ═══ 五步，顺序就是全部安全性 ═══
//   1. `prepareDeletedPathChange` —— 先在日志里立一条 `prepared` 的账（记的是**根相对路径**，
//      不是内容）。
//   2. `changePayloadPath`        —— 算出载荷路径（它自己会再校验一次 change id）。
//   3. `copyPath(target, payload)` —— 把要删的东西**整份**复制进载荷。这一步之后，内容有了第二份。
//   4. 真删。
//   5. `markChangeApplied`        —— 账推到 `applied`。
//
// 反过来（先删再记账）在崩溃窗口里就是「东西没了、日志没有」，永久撤不回来。而多记一条账的
// 代价只是日志目录里多一条 `prepared` 的孤儿——**宁可多一条账，不可少一条账**（change/prepare.ts
// 的同一句）。
//
// ═══ 补偿：每一步失败各有各的还原动作 ═══
//   · 第 2/3 步失败 —— 原件一个字节都没动，只需 `discardPreparedChange` 把账和半成品载荷清掉。
//   · 第 4 步失败   —— 删除可能删了一半（`rm -r` 不是原子的）。`restoreAfterFailure` 先把残缺的
//     目标整个删掉、再从载荷拷回来；**只有还原成功才 discard**——还原失败时那条账是用户唯一的
//     线索，清掉它等于把「删了一半且没有记录」变成常态。
//   · 第 5 步失败   —— 东西已经删掉了，账却停在 `prepared`。直接从载荷拷回目标（此时目标必然
//     不存在，`copyPath` 的「目标已存在就拒」不会误伤）。同样：还原成功才 discard。
//
// 补偿失败时把**两句话都报出去**（`{原因}; automatic restoration also failed: {二次原因}`）：
// 这时磁盘处于中间态，只报第一句会让人以为「失败了但没事」。

import { rm, lstat, unlink } from 'node:fs/promises'
import { errorText } from '../common/errorText'
import { copyPath } from '../change/pathOpsCopy'
import {
  changePayloadPath,
  discardPreparedChange,
  markChangeApplied,
  prepareDeletedPathChange,
} from '../change/prepare'
import { rejectDelete } from './result'
import type { WorkspaceChangeContext, WorkspaceChangeSummary } from '../change/types'

export interface JournaledRemovalRequest {
  /** 变更日志目录。 */
  journalDirectory: string
  context: WorkspaceChangeContext
  /** canonicalize 后的 workspace root，写进账里供回滚时逐字比对。 */
  workspaceRoot: string
  /** 根相对展示路径——**账上记的就是它**，回滚时按它在 root 下重新解析。 */
  displayPath: string
  /** 要删的绝对路径（已确认存在、无软链、在 root 内）。 */
  target: string
  /** 目标是不是目录。决定用递归删除还是 unlink。 */
  directory: boolean
}

/**
 * 记账、备份、删除、结账。成功返回登记回执；任何一步失败都以 `DeleteRejection` 抛出，
 * 抛出之前世界已经被推回原样（或在补偿也失败时，把两段原因一起报出去）。
 */
export async function removeWithJournal(
  request: JournaledRemovalRequest,
): Promise<WorkspaceChangeSummary> {
  const { journalDirectory, context, workspaceRoot, displayPath, target, directory } = request
  const changeId = context.changeId

  let changeSet: WorkspaceChangeSummary
  try {
    changeSet = await prepareDeletedPathChange(
      journalDirectory,
      context,
      workspaceRoot,
      displayPath,
    )
  } catch (error) {
    // 账都没立起来 → 没有可丢弃的东西，也没有任何东西被改动过。
    return rejectDelete(errorText(error))
  }

  let payload: string
  try {
    payload = changePayloadPath(journalDirectory, changeId)
  } catch (error) {
    await discardPreparedChange(journalDirectory, changeId)
    return rejectDelete(errorText(error))
  }

  try {
    await copyPath(target, payload)
  } catch (error) {
    await discardPreparedChange(journalDirectory, changeId)
    return rejectDelete(errorText(error))
  }

  try {
    await removeTarget(target, directory)
  } catch (error) {
    const restoreFailure = await attempt(() => restoreAfterFailure(payload, target))
    if (restoreFailure === undefined) await discardPreparedChange(journalDirectory, changeId)
    return rejectDelete(
      restoreFailure === undefined
        ? `failed to delete path: ${errorText(error)}`
        : `failed to delete path: ${errorText(error)}; automatic restoration also failed: ${restoreFailure}`,
    )
  }

  try {
    await markChangeApplied(journalDirectory, changeId)
  } catch (error) {
    // 目标此刻必然不存在（上一步刚删成功），所以直接拷回来即可，不必先清残缺目标。
    const restoreFailure = await attempt(() => copyPath(payload, target))
    if (restoreFailure === undefined) await discardPreparedChange(journalDirectory, changeId)
    return rejectDelete(
      restoreFailure === undefined
        ? errorText(error)
        : `${errorText(error)}; automatic restoration also failed: ${restoreFailure}`,
    )
  }

  return changeSet
}

/** 目录走递归删除，文件走 unlink——与 Rust 的 `remove_dir_all` / `remove_file` 一一对应。 */
async function removeTarget(target: string, directory: boolean): Promise<void> {
  if (directory) {
    await rm(target, { recursive: true })
    return
  }
  await unlink(target)
}

/**
 * 删除失败之后的还原：先把可能残缺的目标整个清掉，再从载荷拷回来。
 *
 * 清理这一步不能省——`copyPath` 的第一条规矩就是「目标已存在就拒」，留着半棵树会让还原直接失败。
 * 目标已经不存在时（删除失败在第一个条目上）跳过清理。
 */
async function restoreAfterFailure(payload: string, target: string): Promise<void> {
  const stats = await lstatOrUndefined(target)
  if (stats) {
    try {
      // `isDirectory()` 对软链是 false（`lstat` 不跟随），于是软链走 unlink——与 Rust 的
      // `symlink_metadata().is_dir()` 判断逐条一致。
      await rm(target, { recursive: stats.isDirectory() })
    } catch (error) {
      throw new Error(`failed to remove partial target: ${errorText(error)}`)
    }
  }
  await copyPath(payload, target)
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

/** 跑一次补偿：成功给 `undefined`，失败给它的消息文本（补偿的失败从不向上抛）。 */
async function attempt(operation: () => Promise<void>): Promise<string | undefined> {
  try {
    await operation()
    return undefined
  } catch (error) {
    return errorText(error)
  }
}
