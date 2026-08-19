// 把一条路径整个搬到另一处
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_path_ops.rs（已随 T1 删除）的 `move_path`。
//
// 回滚链路上四处都靠它：把可恢复删除的载荷搬回原位、把被 copy 出来的路径搬进载荷、把被 move
// 走的路径搬回 source，以及这三者失败时的补偿搬回。
//
// **rename 失败一律静默退成「复制 + 删源」**（照抄 Rust 的 `if fs::rename(..).is_ok()`）。
// 这不是偷懒：日志目录在用户数据目录、workspace 在别处，两者跨设备时 `rename(2)` 必然
// `EXDEV`，而那是完全正常的部署形态，不该让回滚失败。代价是失去原子性，所以——
//
// **复制成功但删源失败时，必须把复制出来的目标删掉**。否则同一份内容在两个地方各留一份：
// 恢复删除时表现为「文件回来了，但载荷还在」，下一次同 id 的登记会被载荷占用检查拒掉；
// 更糟的是 copy 的回滚（把新建路径搬进载荷）留下双份，用户看到的是「撤销了，文件却还在」。
// 目标清理自身的失败吞掉——此时要报的是删源那个原始错误。

import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errorText } from '../common/errorText'
import { copyPath } from './pathOpsCopy'
import { isDirectory } from './pathProbe'

export async function movePath(source: string, destination: string): Promise<void> {
  const parent = dirname(destination)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    throw new Error(`failed to create \`${parent}\`: ${errorText(error)}`)
  }
  try {
    await rename(source, destination)
    return
  } catch {
    // 跨设备、跨文件系统、目标非空……都在这里退成复制流程，见文件头。
  }
  await copyPath(source, destination)

  let stats
  try {
    stats = await lstat(source)
  } catch (error) {
    throw new Error(`failed to inspect \`${source}\`: ${errorText(error)}`)
  }
  try {
    await rm(source, { recursive: stats.isDirectory() })
  } catch (error) {
    if (await isDirectory(destination)) {
      await rm(destination, { recursive: true, force: true }).catch(() => {})
    } else {
      await rm(destination, { force: true }).catch(() => {})
    }
    throw new Error(`failed to remove copied source \`${source}\`: ${errorText(error)}`)
  }
}
