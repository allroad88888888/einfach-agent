// 绝对路径的对外展示形式：一律正斜杠、一律相对 workspace root
// ---------------------------------------------------------------------------
// 对齐 Rust 侧那几份逐字重复的 `relative_path` / `display_path` / `path_to_slash_string`
// （workspace_read_paths.rs、workspace_write_target_path.rs、workspace_delete.rs、
// workspace_patch_path.rs 各有一份）。Node 侧收成一处。
//
// 为什么结果必须是根相对：返回给模型/前端的 `path` 字段不该泄漏本机绝对路径，而且同一个文件
// 在桌面与 Node 两个宿主下要给出同一个字符串，否则「同一次编辑在两个宿主里看起来是两个文件」。
// 本文件同样不碰文件系统。

import { sep } from 'node:path'
import { isWithinRoot } from './pathContainment'

/** 平台分隔符换成 `/`（unix 上是恒等变换）。等价 Rust 的 `path_to_slash_string`。 */
export function toSlashPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}

/**
 * 绝对路径转成根相对的斜杠路径。
 *
 * 三条与 Rust 逐条对齐的边角：
 *   · 路径就是 root 本身 → `"."`（Rust：strip_prefix 得空串后返回 `"."`）。
 *   · 路径在 root 之外 → **原样返回绝对路径**（Rust：`strip_prefix(...).unwrap_or(path)`）。
 *     这不是兜底，是 Auto 会话的正常输出：读到了 workspace 外的文件，就该显示它真正在哪。
 *   · 判定复用 `isWithinRoot`，不用 `path.relative`——后者对根外路径会给出 `../../x` 这种
 *     相对写法，既不是 Rust 的行为，也读不出「这是根外文件」。
 */
export function relativeToRoot(root: string, absolutePath: string): string {
  if (!isWithinRoot(root, absolutePath)) return toSlashPath(absolutePath)
  const remainder = absolutePath.slice(root.length).replace(/^[\\/]+/, '')
  return remainder === '' ? '.' : toSlashPath(remainder)
}
