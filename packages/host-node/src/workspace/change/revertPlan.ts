// 单条账的回滚预检：把记的相对路径解析出来，顺便看现场还是不是当初那个样子
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_revert.rs:42-90（已随 T1 删除）那段（Rust 侧内联在
// `revert_change_set_blocking` 里）。拆出来是因为 `dryRun` 与真跑**共用它**——预演之所以能
// 「如实报告会发生什么」，正是因为它跑的是同一段冲突检测，不是另写一份宽松版。
//
// 四类账各有各的「没被动过」判据，判据选错的表现是回滚覆盖用户的改动，不是报错：
//   · 整文件改写 → 现在的内容快照必须与账上的 `after` 同状态（比 exists + hash，不比正文）。
//   · 被删路径   → 现在必须**空着**。判据是不跟随软链的 `symlink_metadata`：用户在原地留下的
//     一条悬空软链也算「有东西」，往上盖会把它冲掉。
//   · 被新建路径 → 指纹必须与账上一致。
//   · 被移动路径 → source 必须仍空着，且 destination 的指纹与账上一致。
//
// 冲突**收集完再一起报**，不是撞上第一条就返回：用户要的是「这次回滚有哪些障碍」，逐条修完
// 一次就能过；一次报一条会让人来回试四遍。收集顺序（files → moved → created → relocated）
// 是对外契约的一部分，与 Rust 逐条一致。
//
// 解析路径本身失败（越界、坏路径、软链解不开）**直接抛**，不降级成冲突：那说明这份账与这个
// workspace 根本对不上，不是「现场变了」。

import { sameSnapshotState } from './fileSnapshot'
import { fingerprintOrNull } from './pathOpsFingerprint'
import { symlinkExists } from './pathProbe'
import { readSnapshot } from './snapshotIo'
import { resolveRecordedPath } from './recordedPath'
import type { WorkspaceChangeConflict, WorkspaceChangeSet } from './types'

/** 预检产物：四类账各自解析好的绝对路径（**与条目里的下标一一对应**）+ 收集到的冲突。 */
export interface RevertPlan {
  files: string[]
  moved: string[]
  created: string[]
  relocated: Array<{ source: string; destination: string }>
  conflicts: WorkspaceChangeConflict[]
}

export async function planRevert(
  canonicalRoot: string,
  entry: WorkspaceChangeSet,
): Promise<RevertPlan> {
  const plan: RevertPlan = { files: [], moved: [], created: [], relocated: [], conflicts: [] }

  for (const file of entry.files) {
    const path = await resolveRecordedPath(canonicalRoot, file.path)
    const current = await readSnapshot(path)
    if (!sameSnapshotState(current, file.after)) {
      plan.conflicts.push({ path: file.path, reason: 'file changed after the original tool call' })
    }
    plan.files.push(path)
  }

  for (const moved of entry.movedPaths) {
    const path = await resolveRecordedPath(canonicalRoot, moved.path)
    if (await symlinkExists(path)) {
      plan.conflicts.push({
        path: moved.path,
        reason: 'deleted path was recreated after the original tool call',
      })
    }
    plan.moved.push(path)
  }

  for (const created of entry.createdPaths) {
    const path = await resolveRecordedPath(canonicalRoot, created.path)
    if ((await fingerprintOrNull(path)) !== created.fingerprint) {
      plan.conflicts.push({
        path: created.path,
        reason: 'copied path changed after the original tool call',
      })
    }
    plan.created.push(path)
  }

  for (const relocated of entry.relocatedPaths) {
    const source = await resolveRecordedPath(canonicalRoot, relocated.source)
    const destination = await resolveRecordedPath(canonicalRoot, relocated.destination)
    if (
      (await symlinkExists(source)) ||
      (await fingerprintOrNull(destination)) !== relocated.fingerprint
    ) {
      plan.conflicts.push({
        path: relocated.destination,
        reason: 'moved path changed after the original tool call',
      })
    }
    plan.relocated.push({ source, destination })
  }

  return plan
}
