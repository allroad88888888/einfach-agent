// 源与目标路径的解析：workspace_path_ops.rs 专属的一套禁闭规则
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_path_ops.rs 的 `clean_relative` / `resolve_source` /
// `resolve_destination` / `relative`。
//
// 【为什么不能直接复用 common 的 resolveExistingWorkspacePath / resolveWorkspaceTargetPath】
// 这四个函数是 workspace_path_ops.rs **自己定义**的本地函数，不是共享的 workspace_common.rs
// 那一套（Rust 侧只 `use crate::workspace_common::resolve_workspace_root`，其余都是本文件内的
// private fn）。它们比读/写两种通用形态更严格：
//   · **不接受绝对路径**。读取形态（workspace_read_paths.rs）与写入形态
//     （workspace_write_target_path.rs）都允许原样传入绝对路径，靠 realpath 之后的边界判定
//     拦截；这里 `clean_relative` 在碰 realpath 之前就直接拒——传绝对路径连"越界判定"都够
//     不上，是"参数形状不对"。
//   · **目标不允许已存在**。写入形态的目的地允许已存在（覆盖写是正常情况）；这里存在即拒，
//     因为复制/移动的目的地"已经有东西"永远是调用方的错误，不该被静默覆盖。
// 两套规则混用会导致 pathOps 悄悄接受 `../foo` / 绝对路径，或悄悄覆盖已存在的目标——都不是
// Rust 侧的行为。

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { errorText } from '../common/errorText'
import { hasParentSegment, isWithinRoot } from '../common/pathContainment'
import { pathExists, symlinkExists } from '../change/pathProbe'

const NOT_RELATIVE = 'path must be a non-empty workspace-relative path without `..`'

/**
 * 等价 `clean_relative`：非空、非绝对、无 `..` 分量的 workspace 相对路径。
 *
 * `parse(trimmed).root !== ''` 补的是 `isAbsolute` 在 Windows 上漏掉的一档——`\foo` 这种
 * 有根无盘符前缀的路径不算 Rust 的 `is_absolute()`，但仍带 `Component::RootDir`，同样该拒。
 * 与 `recordedPath.ts` 的 `resolveRecordedPath` 同一套判据（那边注释写得更细）。
 */
function cleanRelative(raw: string): string {
  const trimmed = raw.trim()
  if (
    trimmed === '' ||
    isAbsolute(trimmed) ||
    parse(trimmed).root !== '' ||
    hasParentSegment(trimmed)
  ) {
    throw new Error(NOT_RELATIVE)
  }
  return trimmed
}

/** 等价 `resolve_source`：目标必须已存在，canonicalize 后必须落在 root 内。 */
export async function resolveSource(root: string, raw: string): Promise<string> {
  const joined = join(root, cleanRelative(raw))
  let canonical: string
  try {
    canonical = await realpath(joined)
  } catch (error) {
    throw new Error(`failed to resolve source \`${joined}\`: ${errorText(error)}`)
  }
  if (!isWithinRoot(root, canonical)) {
    throw new Error('source escaped workspace root')
  }
  return canonical
}

/**
 * 等价 `resolve_destination`：目标必须**尚不存在**（`symlink_metadata` 判定，悬空软链也算
 * 存在），最近的已存在祖先必须落在 root 内。返回未 canonicalize 的拼接路径——目标本身还不
 * 存在，没有真实路径可言。
 */
export async function resolveDestination(root: string, raw: string): Promise<string> {
  const joined = join(root, cleanRelative(raw))
  if (await symlinkExists(joined)) {
    throw new Error('destination already exists')
  }
  await confineNearestExistingAncestor(root, joined)
  return joined
}

async function confineNearestExistingAncestor(root: string, target: string): Promise<void> {
  let ancestor = dirname(target)
  for (;;) {
    if (await pathExists(ancestor)) {
      let canonical: string
      try {
        canonical = await realpath(ancestor)
      } catch (error) {
        throw new Error(`failed to resolve destination parent: ${errorText(error)}`)
      }
      if (!isWithinRoot(root, canonical)) {
        throw new Error('destination escaped workspace root')
      }
      return
    }
    const parent = dirname(ancestor)
    // 到文件系统根仍不存在：root 本身必然存在，正常路径走不到这里；对齐 Rust 的
    // `while let Some(parent) = ancestor` 在链条走完（`parent()` 返回 `None`）时安静收尾。
    if (parent === ancestor) return
    ancestor = parent
  }
}

/**
 * 展示用的根相对路径。**故意**无条件 `.replace('\\', '/')`——移植时对齐的是 Rust
 * `workspace_path_ops.rs:220` 的 `relative()`，这是 `docs/node-host-issues.md` 记录过的既有
 * 问题（第 11 条）：unix 上 `\` 是合法文件名字符，真名 `a\b.txt` 会被这里显示成 `a/b.txt`。
 * **移植时照搬未改，理由当时是「不单方面改一份跨宿主契约」。那个理由已经过期**：Rust 侧随 T1
 * 删除，这里是唯一实现，要修就是改这一行、不必再等谁。**但它仍未修**——它是模型可见的展示
 * 字符串，改了会让含 `\` 的路径在回执里换个样子，属于独立的行为改动，不该顺手混进文档卡。
 * 真正正确的版本是 common 的 `relativeToRoot`（`if MAIN_SEPARATOR == '/' { 原样 }`），
 * 读写两侧用的是那个。
 *
 * 不落在 root 内时原样返回**整个绝对路径**（同样做无条件反斜杠替换）——等价原件的
 * `strip_prefix(root).unwrap_or(path)`；这里的调用方永远先经过 resolveSource/resolveDestination
 * 确认过包含关系，这一分支只是移植时为了逐字对齐留下的，不是防御性代码。
 */
export function relativeDisplay(root: string, absolutePath: string): string {
  if (!isWithinRoot(root, absolutePath)) return absolutePath.replace(/\\/g, '/')
  const remainder = absolutePath.slice(root.length).replace(/^[\\/]+/, '')
  return remainder.replace(/\\/g, '/')
}
