// 配置文件的受限原子写：临时文件 → fsync → 收紧权限 → rename
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/web_agent_config_write.rs 的 `write_restricted_atomically`。
//
// **不复用工作区那份 atomicWrite**（Rust 侧同样是两份实现：workspace_common::atomic_write 与
// 本文件的对应物）。两者的权限语义是相反的：工作区那份要**继承原文件权限**，否则一次覆盖就把
// 脚本的可执行位抹掉；配置这份要**强制 0600、目录 0700**，因为文件里有模型 API Key，继承权限
// 意味着「文件原来是 644，就一直是 644」。把它们合成一个带开关的函数，等于让调用方每次现选一次
// 安全级别——漏选的那次不会报错，只会让凭证变成同机可读。
//
// 原子替换而不是 `writeFile`：`writeFile` 是先截断再写，中途崩溃会留下写了一半的 config.json。
// 对配置文件来说**损坏比丢失更糟**——丢失时下次启动是一份干净的空配置，损坏时每次读取都受控
// 失败（parseConfig 拒绝解析），而用户手上没有能修它的界面。

import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const TEMPORARY_ATTEMPTS = 5
const isUnix = process.platform !== 'win32'

/** 同一进程内的临时名去重计数器。见 temporaryPath 的说明。 */
let temporarySequence = 0

/**
 * 把 `contents` 原子落盘到 `path`。目录不存在会被创建。
 *
 * Unix 上目录固定 0700、文件固定 0600；Windows 上跳过（mode 位不表达 POSIX 权限）。
 */
export async function writeRestrictedAtomically(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  const fileName = basename(path)
  if (!fileName || directory === path) throw new Error('模型配置文件路径无效')

  try {
    await mkdir(directory, { recursive: true })
  } catch {
    throw new Error('无法创建模型配置目录')
  }
  await restrictDirectory(directory)

  for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
    const temporary = temporaryPath(directory, fileName, attempt)
    // `wx` = O_CREAT | O_EXCL：抢到名字才算数。撞名说明另一次写入正在用这个名字，换一个重试，
    // 而不是覆盖它——覆盖等于两次写入互相踩，落盘的可能是两份内容的拼接。
    let handle
    try {
      handle = await open(temporary, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new Error('无法创建临时模型配置文件')
    }
    try {
      await publish(handle, temporary, path, directory, contents)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    return
  }
  throw new Error('无法创建临时模型配置文件')
}

/** 写满、落盘、收紧权限、rename，最后 fsync 目录。rename 之后目标才第一次出现新内容。 */
async function publish(
  handle: Awaited<ReturnType<typeof open>>,
  temporary: string,
  path: string,
  directory: string,
  contents: string,
): Promise<void> {
  try {
    try {
      await handle.writeFile(contents, 'utf8')
    } catch {
      throw new Error('无法写入模型配置文件')
    }
    try {
      await handle.sync()
    } catch {
      throw new Error('无法同步模型配置文件')
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  // 先收紧再 rename：反过来的话，目标文件会有一小段窗口是 umask 决定的宽松权限，而那一刻
  // 文件里已经是完整的凭证了。
  await restrictFile(temporary)
  try {
    await rename(temporary, path)
  } catch {
    throw new Error('无法更新模型配置文件')
  }
  await syncDirectory(directory)
}

/**
 * 临时文件名：`.{目标名}-{pid}-{序号}-{attempt}.tmp`，前导点让它在文件列表里保持隐藏。
 *
 * Rust 那份用的是 epoch 纳秒。Node 拿不到同口径的纳秒时钟（`Date.now()` 只有毫秒，同一毫秒内
 * 的两次写入会撞名），所以用进程内自增序号代替——它要保证的本来就只是「同一目录下不撞名」，
 * 跨进程由 pid 区分，撞上了还有 `wx` + 重试兜底。
 */
function temporaryPath(directory: string, fileName: string, attempt: number): string {
  temporarySequence += 1
  return join(directory, `.${fileName}-${process.pid}-${temporarySequence}-${attempt}.tmp`)
}

async function restrictDirectory(directory: string): Promise<void> {
  if (!isUnix) return
  try {
    await chmod(directory, 0o700)
  } catch {
    throw new Error('无法保护模型配置目录')
  }
}

async function restrictFile(path: string): Promise<void> {
  if (!isUnix) return
  try {
    await chmod(path, 0o600)
  } catch {
    throw new Error('无法保护模型配置文件')
  }
}

/** fsync 目录本身，让 rename 这条目录项的变更也落盘（对齐 Rust：失败即整次写入失败）。 */
async function syncDirectory(directory: string): Promise<void> {
  if (!isUnix) return
  let handle
  try {
    handle = await open(directory, 'r')
  } catch {
    throw new Error('无法同步模型配置目录')
  }
  try {
    await handle.sync()
  } catch {
    throw new Error('无法同步模型配置目录')
  } finally {
    await handle.close().catch(() => undefined)
  }
}
