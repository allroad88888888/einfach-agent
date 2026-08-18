// rg 的搜索目标：对齐 Rust 的 `normalize_target_path`
// ---------------------------------------------------------------------------
// Rust 侧这条逻辑没有走 workspace_common 的共用 resolve（workspace_rg.rs 只 import 了
// `read_capped_drain` / `resolve_workspace_root`，路径解析是自己重写的一份）——这正是 Node 侧
// common 目录开头点名的「六个文件各抄一遍」之一。这里改用底座里已经等价移植好的两块拼出来：
//
//   1. `resolveExistingWorkspacePath(root, trimmed, { allowExternalPaths })`
//      —— 目标必须已存在，NUL 检查、realpath、越界判定（含 symlink 逃逸）全部复用，
//      对应 Rust 的 `fs::canonicalize` + `canonical.starts_with(root)`。
//   2. `relativeToRoot(root, absolutePath)`
//      —— 结果落在 root 内时给 `.`（root 自身）或斜杠拼接的相对路径；落在 root 外时原样给
//      斜杠化的绝对路径。这两条分支与 Rust `normalize_target_path` 里
//      `canonical == root → "."` / `strip_prefix(root)` / `!canonical.starts_with(root) → 原样`
//      三段逐条对应，唯一没有对应物的是 Rust 走到这里之前的中间态（那段只是为了推出同一个
//      结果，不是独立行为）。
//
// 传给 rg 的最终字符串会作为它的 cwd 内子路径参数（cwd = root）：根内是相对路径，根外
// （仅 Auto 会话 allowExternalPaths=true 时才可能）是绝对路径——rg 对两种都能正确处理。
//
// 未传或 trim 后为空 → `"."`，且**不碰文件系统**（Rust：`let Some(path) = path else { return
// Ok(".") }`，`trimmed.is_empty()` 同样直接返回，不会等到 canonicalize 才发现「其实就是根」）。

import { relativeToRoot, resolveExistingWorkspacePath } from '../common'

export async function normalizeRgTargetPath(
  root: string,
  rawPath: unknown,
  allowExternalPaths: boolean,
): Promise<string> {
  if (typeof rawPath !== 'string') return '.'
  const trimmed = rawPath.trim()
  if (trimmed === '') return '.'

  const { absolutePath } = await resolveExistingWorkspacePath(root, trimmed, { allowExternalPaths })
  return relativeToRoot(root, absolutePath)
}
