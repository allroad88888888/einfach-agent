// 整批预演：在内存里把整个回滚过一遍，确认每条账都退得动
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_batch.rs:93-150。
//
// ═══ 为什么必须模拟，而不能逐条调用单条预检 ═══
// 同一个文件被连续改过两次（`v1→v2` 记在账 A，`v2→v3` 记在账 B）时，磁盘上现在是 `v3`。
// 逐条预检的话，账 A 的判据是「现在应该是 `v2`」——它当场就冲突了，而实际上只要**先退 B**
// 它就成立。所以这里维护一张「模拟后的文件状态表」：按逆序走，每退一条就把该路径的状态记成
// 它的 `before`，下一条（更老的那条）读到的就是这个模拟值而不是磁盘。
//
// 这也是为什么批量回滚不是「循环调用单条回滚」——那样第一条就会被自己的冲突挡住。
//
// **逆序（新→旧）是唯一正确的方向**，理由同上：先退新的，老的那条的 `after` 才对得上现状。
// 传进来的顺序由调用方按 `createdAt` 定（见 revertChangeSets.ts）。
//
// 载荷缺失是**立即返回**而不是收集成冲突（照抄 Rust）：那不是「现场变了」，是这条账的还原内容
// 本身没了，再往下预演也没有意义。

import { payloadPath } from './entryPaths'
import { fingerprintOrNull } from './pathOpsFingerprint'
import { symlinkExists } from './pathProbe'
import { readSnapshot } from './snapshotIo'
import { resolveRecordedPath } from './recordedPath'
import { sameSnapshotState } from './fileSnapshot'
import type { FileSnapshot, WorkspaceChangeConflict, WorkspaceChangeSet } from './types'

export type BatchSimulation =
  | { kind: 'conflicts'; conflicts: WorkspaceChangeConflict[] }
  | { kind: 'missingPayload'; changeId: string }

/**
 * @param pendingNewestFirst 待回滚的账，**已按执行顺序（新→旧）排好**。
 */
export async function simulateBatchRevert(
  directory: string,
  canonicalRoot: string,
  pendingNewestFirst: readonly WorkspaceChangeSet[],
): Promise<BatchSimulation> {
  // 路径 → 「退到这一步之后它应该是什么样」。没进表的路径以磁盘现状为准。
  const simulated = new Map<string, FileSnapshot>()
  const conflicts: WorkspaceChangeConflict[] = []

  for (const entry of pendingNewestFirst) {
    for (const file of entry.files) {
      const known = simulated.get(file.path)
      const current = known ?? (await readSnapshot(await resolveRecordedPath(canonicalRoot, file.path)))
      if (!sameSnapshotState(current, file.after)) {
        conflicts.push({ path: file.path, reason: `state does not match change set ${entry.id}` })
      }
      simulated.set(file.path, file.before)
    }

    for (const moved of entry.movedPaths) {
      const path = await resolveRecordedPath(canonicalRoot, moved.path)
      if (await symlinkExists(path)) {
        conflicts.push({
          path: moved.path,
          reason: `deleted path was recreated after change set ${entry.id}`,
        })
      }
      if (!(await symlinkExists(payloadPath(directory, entry.id)))) {
        return { kind: 'missingPayload', changeId: entry.id }
      }
    }

    for (const created of entry.createdPaths) {
      const path = await resolveRecordedPath(canonicalRoot, created.path)
      if ((await fingerprintOrNull(path)) !== created.fingerprint) {
        conflicts.push({
          path: created.path,
          reason: `copied path changed after change set ${entry.id}`,
        })
      }
    }

    for (const relocated of entry.relocatedPaths) {
      const source = await resolveRecordedPath(canonicalRoot, relocated.source)
      const destination = await resolveRecordedPath(canonicalRoot, relocated.destination)
      if (
        (await symlinkExists(source)) ||
        (await fingerprintOrNull(destination)) !== relocated.fingerprint
      ) {
        conflicts.push({
          path: relocated.destination,
          reason: `moved path changed after change set ${entry.id}`,
        })
      }
    }
  }

  return { kind: 'conflicts', conflicts }
}
