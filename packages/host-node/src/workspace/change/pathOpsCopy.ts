// 把一条路径（文件或整棵目录树）复制到一个尚不存在的目标
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_path_ops.rs（已随 T1 删除）的 `copy_path`。
//
// 可恢复删除靠它：删之前先把内容整份复制进 `<changeId>.payload`，删掉的东西才有地方可回。
// 所以这里的每一条拒绝都不是洁癖：
//
//   · **目标已存在就拒**。载荷路径撞车意味着上一次删除的唯一副本会被盖掉，那次删除随即变成
//     不可恢复——而且不报错。
//   · **符号链接直接拒**。复制软链有两种同样合理的语义（拷贝链接本身 / 拷贝它指向的东西），
//     选错哪一种都会让「恢复」还原出一个和原来不同的东西。宁可不支持，也不静默选一种。
//   · **权限位要跟着走**。可执行位丢了的话，恢复出来的脚本跑不起来，而文件内容一字不差，
//     排查时根本不会怀疑到删除/恢复这条链上。
//   · **目录复制到一半失败要把半成品删掉**。留一棵残缺的树在载荷路径上，比没有更糟：
//     `prepareDeletedPathChange` 的载荷占用检查会认为「这里已经有账了」。
//
// 一处**没有 Node 对应物**的 Rust 文案：`failed to read directory entry: {err}`。Rust 的
// `read_dir` 是惰性迭代器，逐个条目都可能失败；Node 的 `readdir` 要么整份成功要么整份失败，
// 于是那句只会出现在 Rust 侧。少一条文案不影响任何判定，别为了凑文案编一个假的失败点。

import { chmod, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errorText } from '../common/errorText'
import { symlinkExists } from './pathProbe'

export async function copyPath(source: string, destination: string): Promise<void> {
  if (await symlinkExists(destination)) {
    throw new Error(`destination already exists: \`${destination}\``)
  }
  let stats
  try {
    stats = await lstat(source)
  } catch (error) {
    throw new Error(`failed to inspect \`${source}\`: ${errorText(error)}`)
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`symbolic links are not supported by recoverable delete: \`${source}\``)
  }
  if (stats.isFile()) {
    await copyFileEntry(source, destination, stats.mode)
    return
  }
  if (!stats.isDirectory()) {
    throw new Error(`unsupported file type for recoverable delete: \`${source}\``)
  }
  await copyDirectory(source, destination, stats.mode)
}

async function copyFileEntry(source: string, destination: string, mode: number): Promise<void> {
  const parent = dirname(destination)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    throw new Error(`failed to create \`${parent}\`: ${errorText(error)}`)
  }
  try {
    await copyFile(source, destination)
  } catch (error) {
    throw new Error(`failed to copy \`${source}\` to \`${destination}\`: ${errorText(error)}`)
  }
  await preservePermissions(destination, mode)
}

async function copyDirectory(source: string, destination: string, mode: number): Promise<void> {
  try {
    await mkdir(destination)
  } catch (error) {
    throw new Error(`failed to create \`${destination}\`: ${errorText(error)}`)
  }
  try {
    let children: string[]
    try {
      children = await readdir(source)
    } catch (error) {
      throw new Error(`failed to read \`${source}\`: ${errorText(error)}`)
    }
    for (const name of children) {
      await copyPath(join(source, name), join(destination, name))
    }
    await preservePermissions(destination, mode)
  } catch (error) {
    // 半成品必须清掉，见文件头。清理自身的失败一律吞掉——它跑在失败路径上，冒出来只会盖掉病因。
    await rm(destination, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * 等价 Rust 的 `fs::set_permissions(destination, metadata.permissions())`。
 *
 * 传的是 `lstat` 拿到的完整 `st_mode`（含文件类型位），与 Rust 的 `Permissions` 一致——
 * `chmod(2)` 本来就只认低位，Node 侧实测同样接受（`0o100644` 不报错）。**不要**先 `& 0o777`：
 * 那会顺手抹掉 setuid/setgid/sticky，而恢复出来的目录少了 sticky 位是没人会去查的那种差异。
 */
async function preservePermissions(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error) {
    throw new Error(`failed to preserve permissions: ${errorText(error)}`)
  }
}
