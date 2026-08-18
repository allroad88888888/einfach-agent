// globs 入参校验：对齐 Rust 的 `normalize_globs`
// ---------------------------------------------------------------------------
// 三条拒绝规则逐条对齐（`workspace_rg.rs` 的 `normalize_globs` / `has_parent_component`）：
//   · 含 NUL 字节 —— 拒。
//   · 去掉可选的前导 `!`（否定 glob）后，以 `/` 或 `\` 开头 —— 必须相对，拒。
//   · 含 `..` 分量 —— 拒（复用 pathContainment 的 hasParentSegment，判据与 Rust 的
//     `Component::ParentDir` 一致：按分隔符切分后精确匹配 `..`）。
//
// 非字符串元素没有 Rust 对应物（Rust 侧 `Vec<String>` deserialize 阶段就会挡掉）：这里选择
// 跳过而不是让整个请求失败，与 core 侧 `runtime/workspaceRg.ts` 的 `stringArrayValue` 同一个
// 宽松策略——glob 列表本就是「尽量按调用方说的做」，不值得因为一个混入的非字符串元素拒绝
// 整个搜索请求。

import { hasNulByte, hasParentSegment } from '../common'

export function normalizeGlobs(rawGlobs: unknown): string[] {
  if (!Array.isArray(rawGlobs)) return []

  const normalized: string[] = []
  for (const entry of rawGlobs) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '') continue
    if (hasNulByte(trimmed)) throw new Error('glob cannot contain NUL bytes')

    const pathLike = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed
    if (pathLike.startsWith('/') || pathLike.startsWith('\\')) {
      throw new Error(`glob \`${trimmed}\` must be relative`)
    }
    if (hasParentSegment(pathLike)) {
      throw new Error(`glob \`${trimmed}\` must not contain \`..\` components`)
    }
    normalized.push(trimmed)
  }
  return normalized
}
