// 补丁目标路径的解析：请求路径 → workspace 内的绝对路径
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/workspace_patch_path.rs（已随 T1 删除）整份（`resolve_workspace_path` +
// `ensure_parent_inside_root` + `display_path`）。Rust 那份和写入侧一样是**自成一体**的：
// 不调 workspace_common，confinement 从头到尾自己抄了一遍——正是 common 目录开头点名的
// 「同一条判定在六个文件里各抄一遍」之一。这里不重抄判定，用底座的**纯零件**
// （joinRequestedPath / hasParentSegment / normalizeLexically / isWithinRoot）拼出来。
//
// 但**不能直接用 common 的 `resolveWorkspaceTargetPath`**：patch 这份与写入形态有五处实打实的
// 不同，逐条列在下面，这就是本文件存在的全部理由。
//
// 【patch 比写入形态多做的两件事】
//   1. **目标已存在且自身是符号链接 → 直接拒**（`symlink paths are not supported`）。写入侧
//      没有这条：它把软链 canonicalize 之后按边界判，指向根内的软链是可以写的。patch 一律不碰
//      软链——一次补丁会连着改多个文件，「跟着链接走」意味着同一批里两条路径可能落到同一个
//      inode 上，后一次写覆盖前一次而暂存表毫不知情。
//   2. **目标不存在时额外要求「父目录」在根内**，并且错误文案是 parent 那一套
//      （`parent directory is outside the workspace root` / `path must have a parent directory`）。
//      W13 落盘那步（`write_text_file`）会再调一次 `ensureParentInsideRoot`，所以它是导出的。
//
// 【patch 比写入形态少做 / 做得不一样的三件事】
//   3. **不检查 NUL**。写入侧有 `path cannot contain NUL bytes`，Rust 的 patch 一个字都没有——
//      含 NUL 的路径在这里一路走到底（`symlink_metadata` 报错被当成「不存在」），最后由落盘那步
//      报系统错。Node 侧同样不加检查：`lstat`/`stat` 对 NUL 抛的 TypeError 被 `pathExists` 的
//      catch 吞掉，与 Rust 走同一条分支。**照搬未改**，理由见文件末尾的说明。
//   4. **目标不存在时返回的是词法规范化的路径**，不是「canonical 祖先 + 缺失段」拼回去的那个
//      （写入侧是后者）。差别在根内软链目录上看得见：`<root>/link` 指向 `<root>/real` 时，
//      新建 `link/a.txt` 在 patch 里键是 `<root>/link/a.txt`（写进去也是穿过软链），在写入侧
//      是 `<root>/real/a.txt`。照搬 Rust。
//   5. **错误文案两套**：空路径是 `path must be a non-empty string`（写入侧
//      `path (non-empty string) is required`）、越界是 `path is outside the workspace root`
//      （写入侧 `path must stay within the workspace root`）。同一件事两句话，是移植来源里就有的
//      分叉，照搬未改；它们是模型可见的文案，统一是一次独立的行为改动。
//
// 【错误文案里的路径为什么不过 `toSlashPath`】
// 移植来源用 `to_string_lossy()` / `Path::display()`，Windows 上给的就是反斜杠，这里原样插值。
// （这些消息里是**绝对路径**，会把宿主机目录结构写进模型可见的错误文本——那是移植来源里就有的
// 问题 #5。当年记的是「留给对拍拿决定」，Rust 侧已随 T1 删除，**没有对拍会来拿这个决定了**：
// 它现在是一条无主的既有缺陷，要改就得单开一卡，别指望它自己被顺带解决。）

import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  errorText,
  hasParentSegment,
  isFilesystemRoot,
  isWithinRoot,
  joinRequestedPath,
  normalizeLexically,
  relativeToRoot,
} from '../common'
import { pathExists } from '../common/pathExists'

/** 越界的统一说法（与 Rust patch 侧逐字一致，**不是**写入侧那句）。 */
const OUTSIDE_ROOT = 'path is outside the workspace root'
const PARENT_OUTSIDE_ROOT = 'parent directory is outside the workspace root'

/**
 * 解析一个补丁操作的目标路径（目标可以尚不存在）。
 *
 * 返回值：目标已存在 → canonicalize 后的绝对路径；尚不存在 → 词法规范化后的绝对路径
 * （见文件头第 4 条，这与写入侧不同，是照搬）。失败一律抛错，文案与桌面端逐字一致；调用方
 * （暂存层）负责把它变成 `rejected[].reason`。
 */
export async function resolvePatchPath(root: string, rawPath: string): Promise<string> {
  const trimmed = rawPath.trim()
  if (!trimmed) throw new Error('path must be a non-empty string')
  // Rust 是 join 之后在 `normalize_no_parent` 里遇到 ParentDir 才拒；先在原文上判等价——
  // root 自身是 canonicalize 过的绝对路径，不含 `..`，拼接不会凭空造出一个 ParentDir 分量。
  if (hasParentSegment(trimmed)) throw new Error('path must not contain `..` components')

  const normalized = normalizeLexically(joinRequestedPath(root, trimmed))
  if (!isWithinRoot(root, normalized)) throw new Error(OUTSIDE_ROOT)

  const link = await symlinkMetadata(normalized)
  if (link !== null) {
    if (link.isSymbolic) throw new Error('symlink paths are not supported')
    let canonical: string
    try {
      canonical = await realpath(normalized)
    } catch (error) {
      throw new Error(`failed to resolve path \`${normalized}\`: ${errorText(error)}`)
    }
    if (!isWithinRoot(root, canonical)) throw new Error(OUTSIDE_ROOT)
    return canonical
  }

  await ensureParentInsideRoot(root, normalized)
  return normalized
}

/**
 * 目标的父目录必须在 workspace 内——**连它最近的那个已存在祖先解成真实路径之后也得在**。
 *
 * 后半句才是重点：`<root>/link/new.txt` 里的 `link` 指向根外时，词法上它稳稳在 root 下，
 * 只有把已存在的那段 canonicalize 才看得出来。W13 落盘前要再调一次（`create_dir_all` 会
 * 真的沿着软链建目录，判定必须在建之前和建之后各做一次）。
 */
export async function ensureParentInsideRoot(root: string, path: string): Promise<void> {
  // Rust 的 `Path::parent()` 只有在路径是文件系统根时才给 None。
  if (isFilesystemRoot(path)) throw new Error('path must have a parent directory')
  const parent = dirname(path)
  if (!isWithinRoot(root, parent)) throw new Error(PARENT_OUTSIDE_ROOT)

  const existing = await nearestExistingAncestor(parent)
  let canonical: string
  try {
    canonical = await realpath(existing)
  } catch (error) {
    throw new Error(`failed to resolve parent directory \`${existing}\`: ${errorText(error)}`)
  }
  if (!isWithinRoot(root, canonical)) throw new Error(PARENT_OUTSIDE_ROOT)
}

/**
 * 补丁结果里对外展示的路径：根相对、正斜杠。
 *
 * 复用底座的 `relativeToRoot`（= Rust 写入侧 `relative_path` 的语义），与 Rust patch 的
 * `display_path` 有两处不同，都是**有意**的：
 *   · 路径就是 root 本身：这里给 `"."`，Rust patch 给空串。够不着——`.` 解析出来就是 root，
 *     而暂存第一步就要把它当文本文件读，目录会在那里失败（`is not a regular file`），
 *     永远走不到展示这一步。
 *   · unix 上文件名里含字面反斜杠：Rust patch 无条件 `replace('\\', "/")`，会把名为 `a\b.txt`
 *     的文件显示成、并**写进变更日志**成 `a/b.txt`——回滚时那是另一个路径。同仓库的写入侧
 *     `relative_path` 只在 `MAIN_SEPARATOR == '\\'` 时才替换，两份 Rust 自己就不一致。这里跟
 *     写入侧，等于不复现 patch 那半份的 bug。**已记录，未改 Rust。**
 */
export function patchDisplayPath(root: string, path: string): string {
  return relativeToRoot(root, path)
}

/** `fs::symlink_metadata` 的等价物：拿不到（任何原因）都算「不存在」，与 Rust 的 `if let Ok(..)` 同款。 */
async function symlinkMetadata(path: string): Promise<{ isSymbolic: boolean } | null> {
  try {
    const info = await lstat(path)
    return { isSymbolic: info.isSymbolicLink() }
  } catch {
    return null
  }
}

/** 从 `path` 起逐级上溯，返回第一个存在的祖先。全程都不存在（走到文件系统根）才失败。 */
async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path
  for (;;) {
    if (await pathExists(current)) return current
    // Rust 的 `PathBuf::pop()` 在没有父目录时返回 false，那时才报错——报的是**入参** path，
    // 不是走到的那个 current。
    if (isFilesystemRoot(current)) {
      throw new Error(`no existing ancestor found for \`${path}\``)
    }
    current = dirname(current)
  }
}
