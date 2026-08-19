// 把日志里记的相对路径在 workspace root 下受限还原成绝对路径
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_snapshot.rs（已随 T1 删除）的 `resolve_recorded_path`。
//
// 日志条目里存的是 workspace 相对路径，回滚要写盘就得先变回绝对路径。这一步是回滚链路上**唯一**
// 的路径禁闭点：条目文件本身是磁盘上的普通 JSON，被改过、被换过、被别的 workspace 的日志顶替过
// 都有可能，所以「条目说它是相对路径」不能当真。
//
// 三道判定，一道都不能省：
//   1. **词法拒**：绝对路径、盘符前缀、含 `..` 的一律拒。目标可能还不存在，realpath 无从下手，
//      此时唯一守得住的就是词法层面。（与 common/pathContainment.ts 的写入侧同一条纪律。）
//   2. **存在就 canonicalize 再比边界**：软链要在这一步被解开。词法上不越界的 `link/x` 完全
//      可能指向 workspace 外面。
//   3. **不存在就往上找第一个存在的祖先来比边界**，然后返回**未 canonicalize 的拼接路径**。
//      这不是妥协：目标不存在时没有真实路径可解，而它的父目录已经证明在 root 内；返回拼接路径
//      是为了让调用方能在那个位置**创建**文件（回滚「删除」时正需要这个）。
//
// 边界判定用 `isWithinRoot`（按分量比），不是 `String.startsWith`——`/ws-evil` 不算在 `/ws` 里，
// 理由见 common/pathContainment.ts。

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, parse } from 'node:path'
import { errorText } from '../common/errorText'
import { hasParentSegment, isWithinRoot, joinRequestedPath } from '../common/pathContainment'
import { pathExists } from './pathProbe'

export async function resolveRecordedPath(root: string, relative: string): Promise<string> {
  // `parse(x).root` 挡的是 Rust `Component::Prefix` / `RootDir` 那一档：POSIX 上 `isAbsolute`
  // 已经覆盖，Windows 上 `C:foo`（有盘符、无根）不是绝对路径却同样不该放行。
  if (isAbsolute(relative) || parse(relative).root !== '' || hasParentSegment(relative)) {
    throw new Error('invalid path in workspace change journal')
  }
  // 刻意不用 `path.join`：它会按词法消 `..`，而那与 realpath 的语义不同（见 pathContainment.ts）。
  // 这里 `..` 已经被拒掉了，用 `joinRequestedPath` 是为了保持全仓一条拼接口径。
  const path = joinRequestedPath(root, relative)
  if (await pathExists(path)) {
    return confineExisting(root, path)
  }
  await confineNearestAncestor(root, path)
  return path
}

async function confineExisting(root: string, path: string): Promise<string> {
  const canonical = await canonicalize(path)
  if (!isWithinRoot(root, canonical)) {
    throw new Error('recorded path escaped workspace root')
  }
  return canonical
}

/** 往上找第一个存在的祖先并确认它在 root 内。一个都不存在时什么都不做（等价 Rust 的循环走完）。 */
async function confineNearestAncestor(root: string, path: string): Promise<void> {
  let candidate = dirname(path)
  for (;;) {
    if (await pathExists(candidate)) {
      await confineExisting(root, candidate)
      return
    }
    const parent = dirname(candidate)
    if (parent === candidate) return
    candidate = parent
  }
}

async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new Error(`failed to resolve \`${path}\`: ${errorText(error)}`)
  }
}
