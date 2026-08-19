// 把一条已经退掉的账重新应用回去（批量回滚中途失败时的补偿）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_batch.rs（已随 T1 删除）的 `reapply_change_set_blocking`。
//
// 只有一个调用点：批量回滚退到第 k 条时失败，前面 k-1 条已经退掉了——那时整批必须回到「一条
// 都没退」的样子，否则回执说「失败」而磁盘上是退了一半的状态，是这块最坏的结果。
//
// 方向与回滚完全相反：写回 `after`、把路径搬回载荷、把载荷搬回新建位置、把 source 搬回
// destination，最后把状态推回 `applied`。
//
// **写回前先确认现场还是 `before`**（回滚刚把它写成这样），对不上就报错而不是硬写：那说明在
// 「刚退掉」和「要补回去」这几毫秒里又有别人动过它，此时硬写会吃掉那个人的改动。补偿失败时
// 调用方吞掉错误——它跑在失败路径上，要报的是原始失败——所以这里抛出的错通常没人看得见。
// 这不代表判断可以省：不判的话，被吃掉的改动同样没人看得见。

import { createdPayloadPath, payloadPath } from './entryPaths'
import { readEntry, writeEntry } from './entryStore'
import { sameSnapshotState } from './fileSnapshot'
import { movePath } from './pathOpsMove'
import { readSnapshot, writeSnapshot } from './snapshotIo'
import { resolveRecordedPath } from './recordedPath'

export async function reapplyChangeSet(
  directory: string,
  changeId: string,
  workspaceRoot: string,
): Promise<void> {
  const entry = await readEntry(directory, changeId)

  for (const file of entry.files) {
    const path = await resolveRecordedPath(workspaceRoot, file.path)
    const current = await readSnapshot(path)
    if (!sameSnapshotState(current, file.before)) {
      throw new Error(`cannot compensate changed file ${file.path}`)
    }
    await writeSnapshot(workspaceRoot, path, file.after)
  }

  const payload = payloadPath(directory, changeId)
  for (const moved of entry.movedPaths) {
    await movePath(await resolveRecordedPath(workspaceRoot, moved.path), payload)
  }

  for (const [index, created] of entry.createdPaths.entries()) {
    const path = await resolveRecordedPath(workspaceRoot, created.path)
    await movePath(createdPayloadPath(directory, changeId, index), path)
  }

  for (const relocated of entry.relocatedPaths) {
    const source = await resolveRecordedPath(workspaceRoot, relocated.source)
    const destination = await resolveRecordedPath(workspaceRoot, relocated.destination)
    await movePath(source, destination)
  }

  await writeEntry(directory, { ...entry, status: 'applied' })
}
