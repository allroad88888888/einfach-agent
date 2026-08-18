// 三种「这条路径在不在」的探针
// ---------------------------------------------------------------------------
// Rust 侧在回滚链路上用了**三种不同**的存在性判定，而它们的差别是有意义的，塌成一个就会错：
//
//   · `Path::exists()`            → 跟随符号链接。**悬空软链算不存在。**
//   · `fs::symlink_metadata().is_ok()` → 不跟随。**悬空软链算存在。**
//   · `Path::is_dir()`            → 跟随符号链接，出错算 false。
//
// 用错的后果不是报错，是判反：可恢复删除的还原前提是「那条路径现在确实空着」，判据必须是
// 不跟随的 `symlink_metadata`——否则用户在原地留下的一条悬空软链会被当成「空着」，回滚直接
// 往上盖。反过来，读文件快照要判的是「有没有内容可读」，那必须跟随软链。
//
// 三个都吞掉错误（等价 Rust 的 `.is_ok()` / `.exists()`）：调用方要的是布尔值，权限不足与
// 不存在在这几个判定点上是同一个结论。真正需要区分的地方（读内容、改权限）自己会再失败一次。

import { lstat, stat } from 'node:fs/promises'

/** 等价 `Path::exists()`：跟随符号链接，任何错误都算「不存在」。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 等价 `fs::symlink_metadata(path).is_ok()`：**不**跟随符号链接，悬空软链也算存在。 */
export async function symlinkExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** 等价 `Path::is_dir()`：跟随符号链接，出错算 false。 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
