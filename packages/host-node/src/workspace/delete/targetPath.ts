// 删除目标的路径解析：比读写两侧都严，因为删错了没有第二次机会
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_delete.rs 的 `resolve_delete_path`。
//
// **它不是 common 的 `resolveExistingWorkspacePath` 的调用方，也不该是。** 那个（读取形态）只做
// 一次 `realpath` 再比边界：路径里有软链没关系，解开之后落在根内就放行——读一个经由软链看到的
// 文件是无害的。删除侧不行：
//
//   `<root>/link` → `/etc`，删 `link/passwd` 时 realpath 给的是 `/etc/passwd`，边界判定会拒；
//   但删 `<root>/link/inside.txt`（软链指向根内另一处）时边界判定**放行**，而用户以为自己删的
//   是 `link/` 下面那个东西，实际删的是软链指向的真身。
//
// 所以这里**逐段**检查：从 root 开始把请求路径一段一段接上去，每接一段就 lstat 一次，撞见软链
// 立刻拒。走完全程之后才 canonicalize——此时 canonical 与逐段拼出来的路径必然相同（每一段都
// 已确认不是软链），canonicalize 剩下的作用只是把 `.` 之类的残留规整掉并再比一次边界。
//
// 顺序照抄（每一步的位置都影响「同一个坏输入报哪句话」）：
//   1. trim 后判空 → `path (non-empty string) is required`
//   2. NUL → `path cannot contain NUL bytes`
//   3. 拼到 root 上（绝对路径原样保留，**不**挂到 root 下）
//   4. 词法上出现 `..` → 直接拒（与写入侧同一条理由：不许用词法消 `..`，那与 realpath 语义不同）
//   5. 词法边界 → `path must stay within the workspace root`
//   6. 逐段 lstat，软链即拒
//   7. canonicalize
//   8. canonical === root → `refusing to delete the workspace root`
//   9. canonical 越界 → `path must stay within the workspace root`
//
// ⚠️ **照搬的 Rust 语义（docs/node-host-issues.md 第 5 条同款）**：第 6 步的软链拒绝文案里带的是
// **本机绝对路径**，而回执里的 `path` 字段是根相对——同一次失败的两个字段口径不同，绝对路径会
// 出现在模型可见的错误文本里。不在移植卡里单方面改。
//
// ⚠️ 第 6 步对**最后一段**也做 lstat，所以「目标不存在」在这里就以
// `failed to resolve target path: …` 失败了，pipeline 里那句 `path does not exist` 实际上只在
// TOCTOU 窗口里才可能出现。Rust 侧同样如此，两句都照搬。

import { lstat, realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import {
  errorText,
  hasNulByte,
  hasParentSegment,
  isWithinRoot,
  joinRequestedPath,
  relativeToRoot,
} from '../common'

const OUTSIDE_WORKSPACE = 'path must stay within the workspace root'

/**
 * 把调用方给的路径解析成一个**已存在、无软链、落在 root 内且不是 root 本身**的绝对路径。
 *
 * 失败一律抛（文案跟随 Rust 原文），由 pipeline 折成 `ok: false` 的回执。
 */
export async function resolveDeleteTarget(root: string, requested: string): Promise<string> {
  const trimmed = requested.trim()
  if (!trimmed) throw new Error('path (non-empty string) is required')
  if (hasNulByte(trimmed)) throw new Error('path cannot contain NUL bytes')

  const joined = joinRequestedPath(root, trimmed)
  if (hasParentSegment(joined)) throw new Error('path must not contain `..` components')
  if (!isWithinRoot(root, joined)) throw new Error(OUTSIDE_WORKSPACE)

  let current = root
  for (const segment of relativeSegments(root, joined)) {
    current = `${current}${sep}${segment}`
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      throw new Error(`failed to resolve target path: ${errorText(error)}`)
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`symbolic links are not supported by recoverable delete: \`${current}\``)
    }
  }

  let canonical: string
  try {
    canonical = await realpath(current)
  } catch (error) {
    throw new Error(`failed to resolve target path: ${errorText(error)}`)
  }
  if (canonical === root) throw new Error('refusing to delete the workspace root')
  if (!isWithinRoot(root, canonical)) throw new Error(OUTSIDE_WORKSPACE)
  return canonical
}

/**
 * root 之后那几段的名字。等价 Rust 的 `joined.strip_prefix(root)?.components()` 里的
 * `Component::Normal`：`.`、重复分隔符与结尾分隔符都被丢掉，`..` 上游已经拒过。
 *
 * 借 `relativeToRoot` 做分隔符归一（Windows 的 `\` 变 `/`，unix 上文件名里的字面 `\` 原样保留），
 * 所以这里固定按 `/` 切——**不要**改成按平台 `sep` 切，那会让 unix 上真名带 `\` 的文件被劈成两段。
 *
 * Rust 那条 `_ => Err(OUTSIDE_WORKSPACE)` 分支（撞见 RootDir/Prefix 分量）在这里没有对应物：
 * 剥掉 root 前缀之后的剩余串不可能再含根分量。少一条不可达分支，不是漏了判定。
 */
function relativeSegments(root: string, joined: string): string[] {
  return relativeToRoot(root, joined)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
}
