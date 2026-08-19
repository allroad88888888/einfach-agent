// 把补丁操作暂存进内存文件表，并挑出真正发生变化的路径
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_stage.rs（已随 T1 删除）的 `stage_operation` / `load_state` /
// `changed_paths`——**只留带 IO 的那半边**：解析路径、按需读一次磁盘、把纯规则算出来的新状态写回表。
// 四个操作各自的规则在 stageRules.ts。
//
// 【暂存表在整条流水线里的位置】
// patch 的对外契约是「全部操作成功才落盘，任一失败整体不写」。兑现它的办法不是先写再回滚，而是
// **先把整批改动在内存里算完**：每个被碰到的文件在这张表里留 `initial`（本批开始时磁盘上的样子）
// 与 `current`（暂存到此刻的样子），操作只改 `current`，磁盘一个字都不动。
//
//   · 任一操作被拒 → W13 的流水线把全部拒绝汇总成 `rejected[]` 直接返回，**根本不进落盘那步**，
//     磁盘天然没被碰过，不存在"回滚"这回事。
//   · 全部通过 → `changedPaths` 挑出 `initial !== current` 的那些（没变的文件不写，也就不会
//     刷新 mtime、不会进变更日志），dry run 到此为止；真跑才逐个落盘。
//   · 落盘中途失败（磁盘满、权限）→ 那时才需要真回滚，靠的正是这张表里的 `initial`：把已经写
//     出去的按 initial 逆序还原。**那一步是 W13 的 commit**，不在本文件。
//
// 所以「中间态」就是这张 Map：`initial` 是回滚的唯一依据，`current` 是要落盘的目标状态，
// 两者相等就代表这个文件这一批没有净变化。

import { patchDisplayPath, resolvePatchPath } from './path'
import { nextFileState, validatePatchOperationInput } from './stageRules'
import type { PatchFileState, PatchOperation, ReadInitialText, StagedFiles } from './types'

/**
 * 暂存一个操作。失败抛错，文案与桌面端逐字一致；调用方（W13 的流水线）负责把它记成
 * `rejected[]` 的一条并**继续暂存后面的操作**——Rust 是全部试完再汇总，不是遇错即停。
 *
 * 四步的顺序是契约：**校验入参 → 解析路径 → 按需读磁盘 → 算新状态**。见 stageRules.ts 文件头。
 */
export async function stageOperation(
  root: string,
  files: StagedFiles,
  operation: PatchOperation,
  readInitialText: ReadInitialText,
): Promise<void> {
  validatePatchOperationInput(operation)
  const path = await resolvePatchPath(root, operation.path)
  const state = await loadState(files, path, readInitialText)
  files.set(path, nextFileState(state, operation))
}

/**
 * 拿这个路径的暂存状态；本批第一次碰到它才读一次磁盘。
 *
 * 「只读一次」是语义而不是优化：第二次读会看见批内前一条操作以为自己改过的内容，而磁盘上其实
 * 什么都没变，`initial` 也就不再是「本批开始时的样子」——回滚会把文件还原成一个中途状态。
 */
async function loadState(
  files: StagedFiles,
  path: string,
  readInitialText: ReadInitialText,
): Promise<PatchFileState> {
  const existing = files.get(path)
  if (existing !== undefined) return existing

  const initial = await readInitialText(path)
  const state: PatchFileState = { initial, current: initial, executable: null }
  files.set(path, state)
  return state
}

/**
 * 挑出净变化的路径（`initial !== current`），按**展示路径**排序。
 *
 * 排序用 UTF-8 字节序而不是 JS 默认的 UTF-16 码元序：Rust 的 `sort_by_key` 拿 `String` 当键，
 * 比的是字节。两者对 BMP 内的字符一致，遇到增补平面字符（emoji、生僻汉字）会给出相反的顺序
 * ——代理对的首码元 0xD800 比 0xFFFD 小，而它的 UTF-8 首字节 0xF0 比 0xEF 大。这个顺序会出现在
 * `changedFiles` / `changes[]` 里，也就是模型和聊天记录看到的顺序，两个宿主必须同款。
 */
export function changedPaths(root: string, files: StagedFiles): string[] {
  const changed: Array<{ path: string; key: Buffer }> = []
  for (const [path, state] of files) {
    if (state.initial === state.current) continue
    changed.push({ path, key: Buffer.from(patchDisplayPath(root, path), 'utf8') })
  }
  changed.sort((left, right) => Buffer.compare(left.key, right.key))
  return changed.map((entry) => entry.path)
}
