// 崩溃安全的整文件替换
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs（已随 T1 删除）的 `atomic_write`。步骤一个都不能省：
//
//   同目录临时文件 → write → fsync → 继承原文件权限位 → rename 覆盖
//
//   · **临时文件 + rename**：`fs.writeFile` 是先截断再写，中途断电就是「内容丢了、原文件也回不
//     来」。换成同目录临时文件再 rename，任何时刻崩溃，磁盘上留下的要么是旧文件、要么是新
//     文件，没有第三种。同目录是必须的——跨文件系统的 rename 不是原子操作（而且会 EXDEV）。
//   · **fsync**：rename 本身原子，但「数据已经落盘」不是它保证的。少了这一步，断电后可能出现
//     目录项已指向新文件、而新文件内容还是空洞的情况。Node 里就是 `fileHandle.sync()`。
//   · **权限位回填**：rename 保留的是**临时文件**的权限（由 umask 决定，通常 0644），于是一次
//     覆盖就把脚本的可执行位悄悄抹掉了。这个 bug 只在几周后「那个脚本怎么跑不了了」时才发作，
//     所以必须显式回填，并有测试钉住。
//
// 刻意不做的一件事：rename 之后不 fsync 父目录。Rust 侧也没做，两个宿主的耐久性语义保持一致；
// 真要加，那是两边一起加的事，不是 Node 侧单方面「顺手加固」。

import { chmod, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, sep } from 'node:path'
import { errorText } from './errorText'

/** 权限位掩码：只取 setuid/setgid/sticky + rwx 九位，file type 位不属于 chmod 的入参。 */
const PERMISSION_BITS = 0o7777

/**
 * 原子地把 `content` 写成 `targetPath` 的全部内容。目标已存在时保留它的权限位。
 *
 * 失败时清掉临时文件再把错误抛出去——留一堆 `.foo.12345-....tmp` 在工作区里，既污染 git
 * status 也污染下一次 list。
 */
export async function atomicWrite(targetPath: string, content: string | Uint8Array): Promise<void> {
  const parent = dirname(targetPath)
  if (parent === targetPath) throw new Error('target path has no parent directory')
  const temporary = temporaryPathFor(parent, basename(targetPath) || 'workspace-write')

  try {
    await writeAndSync(temporary, content)
    await inheritPermissions(targetPath, temporary)
    await rename(temporary, targetPath).catch((error: unknown) => {
      throw new Error(`failed to replace target file: ${errorText(error)}`)
    })
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * 临时文件名：`.<原名>.<pid>-<纳秒>.tmp`。
 *
 * · **前导点**让它在 watcher / 文件列表 / git status 里保持隐藏，减少对开发工具链的干扰
 *   （照搬 Rust 侧的理由）。
 * · **pid + 纳秒**保证并发写同一个文件的两个调用不会撞到同一个临时名。用
 *   `process.hrtime.bigint()`（进程内单调、纳秒精度）而不是 `Date.now()`：毫秒精度下同一
 *   毫秒内的两次写会同名，而 pid 只能区分进程、区分不了同进程内的并发。
 */
function temporaryPathFor(parent: string, name: string): string {
  const separator = parent.endsWith(sep) ? '' : sep
  return `${parent}${separator}.${name}.${process.pid}-${process.hrtime.bigint()}.tmp`
}

async function writeAndSync(temporary: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(temporary, 'w').catch((error: unknown) => {
    throw new Error(`failed to create temporary file: ${errorText(error)}`)
  })
  // close 放 finally：写或 fsync 失败时错误照常抛出，但句柄一定要还回去，否则错误路径漏 fd。
  try {
    await handle.writeFile(content).catch((error: unknown) => {
      throw new Error(`failed to write temporary file: ${errorText(error)}`)
    })
    await handle.sync().catch((error: unknown) => {
      throw new Error(`failed to flush temporary file: ${errorText(error)}`)
    })
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 把原文件的权限位复制到临时文件上。
 *
 * 原文件不存在（新建）→ 什么都不做，临时文件保持 umask 默认，与直接新建一个文件同样。
 * 回填失败不阻断替换：Rust 侧写的是 `let _ = fs::set_permissions(...)`，同一个取舍——
 * 权限没跟上总好过内容没写进去。
 *
 * 用 `stat` 而不是 `lstat`（Rust 用的是跟随链接的 `fs::metadata`）：目标是符号链接时，取的是
 * 链接目标的权限位，而 rename 换掉的是链接本身。两个宿主同款，别在这里各自"修正"。
 */
async function inheritPermissions(targetPath: string, temporary: string): Promise<void> {
  try {
    const stats = await stat(targetPath)
    await chmod(temporary, stats.mode & PERMISSION_BITS)
  } catch {
    // 原文件不存在，或本平台/文件系统不支持改权限——都按 Rust 的语义静默跳过。
  }
}
