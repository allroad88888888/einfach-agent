// 补丁落盘的四个原语：读旧文本、写、置执行位、删
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_fs.rs（已随 T1 删除）整份。**这一层是补丁域里唯一真的碰磁盘的地方**
// （暂存只在内存里算，流水线只做编排），所以每个失败点的文案都直接是模型看到的那句话，逐字照搬。
//
// 【读那一半与写那一半的关系】
// `readOptionalTextFile` 是 W12 `ReadInitialText` 那个口子的生产实现：整批开始时每个被碰到的文件
// 读一次，结果存进暂存表的 `initial`。后面三个是提交阶段用的，见 commit.ts。
//
// 【上限用的是同一个 `MAX_FILE_BYTES`，文案不同】
// limits.ts 那边校验的是**入参与算出来的结果文本**（`content exceeds N byte limit`，带 label）；
// 这里校验的是**磁盘上那个文件多大**（`file exceeds N byte limit`，不带 label）。同一个常量、
// 两句话，是 Rust 侧既有的分工，别合并。
//
// 【为什么写要走 atomicWrite】
// Rust 侧那行注释说得很清楚：commit 中途失败/断电不能留下截断文件，否则**回滚面对的已经是一个
// 坏文件了**——`initial` 还原得回去的前提是那个文件要么是旧的、要么是新的，没有第三种。

import { chmod, mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite, errorText, isWithinRoot } from '../common'
import { pathExists } from '../common/pathExists'
import { MAX_FILE_BYTES } from './limits'
import { ensureParentInsideRoot } from './path'

/** 权限位掩码。`stat` 给的 `mode` 含文件类型位，而 `chmod` 的入参只该带这 12 位。 */
const PERMISSION_BITS = 0o7777

/** UTF-8 合法性判定。Rust 的 `String::from_utf8` 对非法序列是**报错**而不是替换成 `�`。 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * 读一个文件的当前文本；不存在给 `null`。
 *
 * 「不存在」的判据是 Rust 的 `Path::exists()`——跟随符号链接、**任何错误都算不存在**（包括
 * 权限不足）。这看着松，但它是照搬：权限不足时 Rust 同样返回 `Ok(None)`，于是 `add_file` 在暂存
 * 阶段放行、到提交那步才由真正的写失败报出来。两个宿主必须在同一个点上失败。
 *
 * 判定顺序（每一步的文案都不同，别调换）：存在性 → 是不是普通文件 → 元数据里的大小 → 实际读到的
 * 字节数 → 有没有 NUL → 是不是合法 UTF-8。
 */
export async function readOptionalTextFile(path: string): Promise<string | null> {
  if (!(await pathExists(path))) return null

  let info: Awaited<ReturnType<typeof stat>>
  try {
    // Rust 在 `exists()` 之后又取了一次 metadata，两次之间被删掉时报的是这句。照搬这一次多余的
    // 系统调用：合并成一次会让这条分支永远走不到，而它是两个宿主对同一个竞态的同一句话。
    info = await stat(path)
  } catch (error) {
    throw new Error(`failed to read metadata for \`${path}\`: ${errorText(error)}`)
  }
  if (!info.isFile()) throw new Error(`\`${path}\` is not a regular file`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`)

  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
  }
  // 再判一次实际字节数：元数据是读之前拿的，文件可能在两步之间长大（Rust 同样判两次）。
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`)
  }
  if (bytes.includes(0)) throw new Error('binary files are not supported')

  try {
    return strictUtf8.decode(bytes)
  } catch {
    // Rust 的 `String::from_utf8` 失败也归到这一句——不是「编码错误」，对模型来说结论都是
    // 「这个文件补丁工具处理不了」。
    throw new Error('binary files are not supported')
  }
}

/**
 * 把 `content` 写成 `path` 的全部内容，必要时建出父目录。
 *
 * **父目录判定要做两次**，这是本文件最容易被"优化"掉的一处：
 *   1. `ensureParentInsideRoot`（建目录**之前**）——那时最近的已存在祖先可能还在很上层，判的是
 *      「顺着现有的软链走下去会不会出根」。
 *   2. `mkdir -p` 之后再 canonicalize 一次父目录——`mkdir -p` 会**沿着软链**把目录建出来，建完
 *      之后父目录才第一次有真身可解。少了这一步，`<root>/link/新目录/a.txt` 能把文件写到根外，
 *      而第 1 步看不出来（那时 `新目录` 还不存在，最近祖先是 `link` 自己）。
 */
export async function writeTextFile(root: string, path: string, content: string): Promise<void> {
  await ensureParentInsideRoot(root, path)

  // Rust 是 `if let Some(parent) = path.parent()`，无父目录时整段跳过。Node 这边够不着：
  // `ensureParentInsideRoot` 已经把文件系统根拒在门外（`path must have a parent directory`）。
  const parent = dirname(path)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    throw new Error(`failed to create parent directory \`${parent}\`: ${errorText(error)}`)
  }

  let canonicalParent: string
  try {
    canonicalParent = await realpath(parent)
  } catch (error) {
    throw new Error(`failed to resolve parent directory \`${parent}\`: ${errorText(error)}`)
  }
  if (!isWithinRoot(root, canonicalParent)) {
    throw new Error('parent directory is outside the workspace root')
  }

  try {
    await atomicWrite(path, content)
  } catch (error) {
    throw new Error(`failed to write \`${path}\`: ${errorText(error)}`)
  }
}

/**
 * 置/清执行位。**必须在 `writeTextFile` 之后调**：`atomicWrite` 会把原文件的权限位回填到临时
 * 文件上再 rename，先置后写等于白置。
 *
 * 置位规则照搬 write_file：`mode | ((mode & 0o444) >> 2)`——**有读权限的角色才拿到执行权限**
 * （0644 → 0755，0600 → 0700）。直接 `| 0o111` 会给 group/other 发一个它们连读都没有的执行位。
 * 清位是无条件的 `& ~0o111`。
 *
 * Windows 上整个函数是 no-op（Rust 用 `#[cfg(not(unix))]` 给了个空实现）——NTFS 没有这个位，
 * 在那里报错等于让同一份补丁在两个平台上一个成功一个失败。
 */
export async function applyExecutableBit(path: string, executable: boolean): Promise<void> {
  if (process.platform === 'win32') return

  let mode: number
  try {
    mode = (await stat(path)).mode & PERMISSION_BITS
  } catch (error) {
    throw new Error(`failed to inspect file mode: ${errorText(error)}`)
  }

  const updated = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111
  // 没变就别调 chmod：Rust 同样早退。省的不是那一次系统调用，是只读文件系统上一次无谓的失败。
  if (updated === mode) return

  try {
    await chmod(path, updated)
  } catch (error) {
    throw new Error(`failed to update file mode: ${errorText(error)}`)
  }
}

/** 删一个文件；本来就不在就当成功（回滚里「把新建的文件删掉」会重复走到这条）。 */
export async function deleteFileIfPresent(path: string): Promise<void> {
  if (!(await pathExists(path))) return
  try {
    await unlink(path)
  } catch (error) {
    throw new Error(`failed to delete \`${path}\`: ${errorText(error)}`)
  }
}
