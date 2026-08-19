// 把暂存结果落到磁盘，中途失败则按 `initial` 逆序还原
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_commit.rs（已随 T1 删除）整份。**整条补丁流水线里唯一会留下半成品的
// 一步就是这里**，所以它单独成文件：上游（暂存）保证「任一操作被拒 → 根本不进这一步」，本文件
// 只负责「已经开始写了、写到一半炸了怎么办」。
//
// 【「全部成功才落盘」在这里是什么意思】
// 契约的主力不在本文件——整批改动在内存里算完（W12 的暂存表），有任何一条不成立就直接返回
// `rejected[]`，磁盘一个字都没动过。走到 `commitChanges` 时，剩下的失败只有**环境性**的：磁盘满、
// 权限、父路径其实是个文件、并发有人把目录换成了文件。这一类没法预先算掉，只能事后还原。
//
// 【还原的方向与依据】
//   · 依据是 `initial`（本批开始时磁盘上的样子），不是 `current`——`current` 是目标状态，
//     它正是我们要撤销的东西。
//   · **逆序**（后写的先还原）。同一批里两条路径可能有先后依赖：先删掉文件 `d`、再在 `d/` 下建
//     新文件，还原时必须先把 `d/x` 删掉、再把文件 `d` 写回去，反过来第二步一定失败。
//   · 还原自身失败**不掩盖原始错误**：把两句话拼成 `"{原始错误}; failed to rollback partially
//     applied patch: {逐条还原错误}"`。原始错误在前，因为那才是病因；还原失败在后，因为它决定
//     的是「现在磁盘处于什么状态」——这时工作区确实是半改的，模型需要知道。

import { applyExecutableBit, deleteFileIfPresent, writeTextFile } from './fs'
import type { StagedFiles } from './types'

/**
 * 按 `changedPaths` 的顺序逐个落盘。全部成功才返回；任一失败先尝试还原已写的部分，再抛错。
 *
 * `changedPaths` 已经由 `changedPaths()` 按展示路径排好序，本函数不再排——提交顺序是可观测的
 * （失败时哪些文件已经被改过），两个宿主必须一致。
 */
export async function commitChanges(
  root: string,
  changedPaths: readonly string[],
  files: StagedFiles,
): Promise<void> {
  const applied: string[] = []

  for (const path of changedPaths) {
    const state = files.get(path)
    // 构造上不可能（`changedPaths` 就是从这张表里挑出来的）。照搬 Rust 的 `?`：**这一条不触发
    // 还原**——它说明调用方传进来的两个参数根本不是一对，那时"还原"要还原到哪个状态也是没根据的。
    if (state === undefined) throw new Error(`missing staged state for \`${path}\``)

    try {
      if (state.current !== null) {
        await writeTextFile(root, path, state.current)
        // 执行位必须在写之后：`atomicWrite` 会把**原文件**的权限位回填到临时文件再 rename，
        // 先置后写会被那次回填盖掉。`null` = 整批没人提过 executable，那就不动权限位
        // （此时 atomicWrite 的回填已经把原来的执行位保住了）。
        if (state.executable !== null) await applyExecutableBit(path, state.executable)
      } else {
        await deleteFileIfPresent(path)
      }
    } catch (error) {
      const reason = messageOf(error)
      const rollbackError = await rollbackChanges(root, applied, files)
      throw new Error(rollbackError === null ? reason : `${reason}; ${rollbackError}`)
    }

    applied.push(path)
  }
}

/**
 * 把已经落盘的那些按 `initial` 逆序还原。全成功返回 `null`，否则返回汇总后的一句话。
 *
 * **不抛错、返回值**：调用方手里还攥着原始失败，抛出去会让两个错误抢同一条通道。逐条失败全部
 * 收集完再汇总，不遇错即停——已经在还原了，能多救回一个是一个。
 */
async function rollbackChanges(
  root: string,
  applied: readonly string[],
  files: StagedFiles,
): Promise<string | null> {
  const failures: string[] = []

  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const path = applied[index]
    const state = files.get(path)
    if (state === undefined) {
      // 与 commitChanges 里那条一样够不着；照搬 Rust 保留它，免得将来有人换了传参方式却发现
      // 这里默默跳过了一个文件。
      failures.push(`missing rollback state for \`${path}\``)
      continue
    }
    try {
      if (state.initial !== null) {
        await writeTextFile(root, path, state.initial)
      } else {
        await deleteFileIfPresent(path)
      }
    } catch (error) {
      failures.push(messageOf(error))
    }
  }

  if (failures.length === 0) return null
  return `failed to rollback partially applied patch: ${failures.join('; ')}`
}

/** fs.ts 抛的一律是 `Error`；非 Error 值走 String() 兜底，免得拼出 `[object Object]`。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
