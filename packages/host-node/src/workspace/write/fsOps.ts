// 真正落盘的三个原语：新建、追加、可执行位
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_fs_ops.rs（已随 T1 删除）。覆盖不在这里——那一路走 N2 的
// `atomicWrite`（临时文件 → fsync → 回填原权限 → rename），本文件只放「不经临时文件」的两种。
//
// 【为什么 create 不走原子写】
// `create` 的全部意义就是「文件已存在就失败」，而这件事只有内核的 O_CREAT|O_EXCL（Node 的
// `wx`）能无窗口地判定。先 stat 再写有窗口；改成临时文件 + rename 更是直接把语义弄反——rename
// 会**覆盖**已存在的目标，那正是 create 要拒绝的事。
//
// 【为什么 append 不走原子写】
// 原子写要先把整个文件读出来再整份换掉，追加一行日志的代价会变成「读写整个归档」；而 `a` 模式
// 的写入在 POSIX 上本来就带 O_APPEND 的原子定位。代价是崩溃时可能留下半条记录——归档格式
// （JSONL）对此是容错的，解析时丢掉残行即可。

import { chmod, stat, writeFile } from 'node:fs/promises'
import { errorText } from '../common'
import { rejectWrite } from './result'

/** 新建一个文件；已存在就按设计拒绝，并指出「确实想替换就用 overwrite」。 */
export async function writeCreate(path: string, content: Uint8Array): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      rejectWrite('file already exists; use mode "overwrite" only when replacing it is intentional')
    }
    rejectWrite(errorText(error))
  }
}

/** 追加到文件尾；文件不存在就建（Rust 的 `.create(true).append(true)`）。 */
export async function writeAppend(path: string, content: Uint8Array): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'a' })
  } catch (error) {
    rejectWrite(errorText(error))
  }
}

/**
 * 按调用方的显式要求设置或清除可执行位。**内容写完之后**才做——顺序见 pipelineWrite.ts。
 *
 * 置位时**镜像读权限**（`mode | ((mode & 0o444) >> 2)`）：组/其他能读的文件也让它们能执行，
 * 而不是无脑 `0o755`——后者会把一个 0600 的私有脚本变成人人可读可执行。
 * 清除时只抹掉 `0o111` 三位，其余权限原样。
 * 算出来与原值相同就**不 chmod**：省一次系统调用，也不去动文件的 ctime。
 *
 * Windows 上无 POSIX 权限位，整个函数是 no-op（对齐 Rust 的 `#[cfg(not(unix))]` 分支）。
 */
export async function applyExecutableBit(path: string, executable: boolean): Promise<void> {
  if (process.platform === 'win32') return
  const stats = await stat(path).catch((error: unknown) =>
    rejectWrite(`failed to inspect file mode: ${errorText(error)}`),
  )
  const mode = stats.mode
  const updated = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111
  if (updated === mode) return
  // 传完整 st_mode（含 setuid/setgid/sticky），不做 `& 0o777`——掩掉会在一次覆盖里静默丢掉
  // 这些位。Rust 的 `set_permissions` 同样传原样的 mode。
  await chmod(path, updated).catch((error: unknown) =>
    rejectWrite(`failed to update file mode: ${errorText(error)}`),
  )
}
