// `search_workspace_files` 的文件名过滤：一个刻意简化的「glob」，不是真 glob
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_search.rs（已随 T1 删除）的 `matches_glob`。**这不是** `*` / `?` /
// `[...]` 的完整 glob 语法，只是四个字面前缀分支；照抄不改，即使某些写法（比如 `**.ts`）不会
// 按直觉工作——两个宿主必须对同一个 glob 给出同一个答案，标准更严格的实现反而是分裂。
//
// 四个分支互斥，按顺序试：
//   1. 以 `*` 开头 → 只剥掉**最前面这一个** `*`（`strip_prefix('*')`，不是剥所有前导 `*`），
//      剩下的整段当**后缀**比较。`**.ts` 因此剥成后缀 `*.ts`，按字面（含中间那个 `*`）比较，
//      不会被当成两层前缀。
//   2. 以 `.` 开头（且未落进分支 1）→ 整个 pattern 当后缀比较，等价「按扩展名」用法（`.ts`）。
//   3. 含 `*`（不在开头）→ 把所有 `*` 抹掉当**子串**比较（`a*b` 变成 `ab`，只要路径里含
//      `"ab"` 就算命中，`*` 完全不参与位置约束）。
//   4. 都不是 → 整个 pattern 当子串比较。
//
// 每一分支都会**同时**试 `relPath`（workspace 相对路径）与 `fileName`（basename），任一命中即真。

/**
 * `path` 与 `fileName` 是否匹配给定的（可能为空）glob。`glob` 为空/未给时视为「匹配一切」。
 */
export function matchesGlob(relPath: string, fileName: string, glob: string | undefined): boolean {
  if (glob === undefined) return true
  const pattern = glob.trim()
  if (pattern === '') return true

  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1)
    return relPath.endsWith(suffix) || fileName.endsWith(suffix)
  }
  if (pattern.startsWith('.')) {
    return relPath.endsWith(pattern) || fileName.endsWith(pattern)
  }
  if (pattern.includes('*')) {
    const needle = pattern.split('*').join('')
    return needle === '' || relPath.includes(needle) || fileName.includes(needle)
  }

  return relPath.includes(pattern) || fileName.includes(pattern)
}
