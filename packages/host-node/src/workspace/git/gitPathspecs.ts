// diff pathspec 的 workspace 内 confine 校验与归一化
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_git_path.rs。产出是**根相对、正斜杠**的 pathspec 串，
// 交给 gitArgs.ts 放在 `--` 之后；git 以 workspace root 为 cwd 运行，且带
// `GIT_LITERAL_PATHSPECS=1`（pathspec 元字符不再展开，见 gitExec.ts）。
//
// ═══ 为什么 diff 的路径也要过 confinement ═══
// `get_workspace_diff` 收调用方给的 `paths`。不校验的话，`../../../etc` 这类路径会让「看
// workspace 的改动」变成「看 workspace 之外的内容」——git 会拒绝仓库外的 pathspec，但
// workspace root 未必等于仓库根（root 可以显式传入、可以是仓库里的子目录），那时越界是成立的。
//
// ═══ 与 workspace/common 那两个 resolve 不是同一件事 ═══
// common 的 `resolveExistingWorkspacePath` / `resolveWorkspaceTargetPath` 产出的是**绝对路径**，
// 给 fs 系统调用用；这里要的是**给 git 的相对 pathspec**，而且允许目标已被删除（`git status`
// 报的删除文件本来就不存在了）。Rust 侧同样另写了一份，不是复用那两个——照搬。
//
// 三类输入各走哪条路：
//   · 相对路径 —— 词法上就不许出现 `..`（写入侧同款理由：目标可能不存在，realpath 无从下手）；
//   · 绝对路径 —— 先按词法消 `..`（消不动 = 越过文件系统根 → 拒），再比边界；
//   · 两者最后都要拿「最近的已存在祖先」canonicalize 一次再比边界——这一步才拦得住 symlink
//     逃逸（根内一个软链指向根外，词法上一个字都看不出来）。

import { realpath, stat } from 'node:fs/promises'
import { dirname, join, parse, sep } from 'node:path'
import { errorText, hasNulByte, isWithinRoot, toSlashPath } from '../common'
import { trimUnicodeWhitespace } from './unicodeWhitespace'

/** unix 只认 `/`（字面 `\` 是合法文件名的一部分）；windows 两种都认。与 common 同款判据。 */
const SEGMENT_SEPARATOR = sep === '\\' ? /[\\/]+/ : /\/+/

/**
 * 把调用方给的一批路径收窄成 workspace 内的相对 pathspec。
 * 未给 / 给空数组都返回空数组——流水线据此退回「全仓 status + 全仓 diff」。
 */
export async function normalizePathspecs(
  paths: readonly string[] | undefined,
  root: string,
): Promise<string[]> {
  if (paths === undefined) return []
  const normalized: string[] = []
  for (const path of paths) normalized.push(await normalizePathspec(path, root))
  return normalized
}

async function normalizePathspec(path: string, root: string): Promise<string> {
  const trimmed = trimUnicodeWhitespace(path)
  if (trimmed === '') throw new Error('git diff path cannot be empty')
  if (hasNulByte(trimmed)) throw new Error(`git diff path \`${trimmed}\` contains a NUL byte`)

  const relative = isRooted(trimmed)
    ? await relativeFromAbsolute(trimmed, root)
    : await relativeFromRelative(trimmed, root)

  if (relative === '') {
    // 空 pathspec 传给 git 等于「全仓」，与调用方写下一个具体路径的意图正好相反。
    throw new Error('git diff path cannot resolve to the workspace root; omit paths instead')
  }
  return relative
}

/**
 * 路径是否带根/盘符前缀。等价 Rust 的「有 `Component::RootDir` 或 `Component::Prefix`」，
 * 比 `isAbsolute` 宽一档：windows 的 `C:foo` 是盘符相对路径（isAbsolute 为假），Rust 会把它
 * 判成 Prefix 并拒绝，直接用 isAbsolute 会把它当成普通相对路径挂到 root 下。
 */
function isRooted(value: string): boolean {
  return parse(value).root !== ''
}

async function relativeFromAbsolute(path: string, root: string): Promise<string> {
  const candidate = lexicalNormalizeAbsolute(path)
  if (!isWithinRoot(root, candidate)) {
    throw new Error(`git diff path \`${path}\` escapes workspace root \`${root}\``)
  }
  await ensureExistingAncestorInRoot(candidate, root, path)
  return toSlashPath(candidate.slice(root.length).replace(/^[\\/]+/, ''))
}

async function relativeFromRelative(path: string, root: string): Promise<string> {
  const segments: string[] = []
  for (const segment of path.split(SEGMENT_SEPARATOR)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // 相对路径里的 `..` **直接拒**，不是先按词法消掉再判：目标可能还不存在（被删除的文件
      // 正是 diff 最常见的入参），没有 realpath 可查，词法层面就是唯一防线。
      throw new Error(`git diff path \`${path}\` must stay inside workspace root`)
    }
    segments.push(segment)
  }

  await ensureExistingAncestorInRoot(join(root, ...segments), root, path)
  return segments.join('/')
}

/**
 * 从候选路径往上找到最近的**已存在**祖先，canonicalize 它并比边界。
 *
 * 只有这一步看得见符号链接：`<root>/link/x` 里 `link` 若指向根外，词法判定完全无感，
 * 解开链接后才暴露。目标本身不存在是正常的（删除/重命名），所以是往上找祖先而不是要求存在。
 */
async function ensureExistingAncestorInRoot(
  candidate: string,
  root: string,
  original: string,
): Promise<void> {
  let existing = candidate
  while (!(await pathExists(existing))) {
    const parent = dirname(existing)
    if (parent === existing) {
      throw new Error(`git diff path \`${original}\` has no accessible parent`)
    }
    existing = parent
  }

  let canonical: string
  try {
    canonical = await realpath(existing)
  } catch (error) {
    throw new Error(`failed to resolve path \`${existing}\`: ${errorText(error)}`)
  }
  if (!isWithinRoot(root, canonical)) {
    throw new Error(`git diff path \`${original}\` escapes workspace root \`${root}\``)
  }
}

/**
 * 词法规范化一个绝对路径：吃掉 `.`、按词法消 `..`，消到没得消（越过文件系统根）就拒。
 *
 * **刻意不用 `path.normalize`**：它对 `/..` 这类越根写法静默给出 `/`，而这里必须失败——
 * 一个能把自己消到文件系统根的输入，后面每一步边界判定都会以「它在根外」通过，症状是
 * 一句语焉不详的 escapes 而不是「这个路径本身不合法」。
 *
 * 对 git 而言词法消 `..` 才是对的口径：pathspec 是拿去和索引/工作树里的路径比对的，不是拿去
 * 做系统调用的，git 自己也按词法理解它。
 */
function lexicalNormalizeAbsolute(path: string): string {
  const prefix = parse(path).root
  const segments: string[] = []
  for (const segment of path.slice(prefix.length).split(SEGMENT_SEPARATOR)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`absolute git diff path \`${path}\` cannot be normalized`)
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  // prefix 自带结尾分隔符（`/`、`C:\`），所以直接拼即可；segments 为空时结果就是文件系统根。
  return prefix + segments.join(sep)
}

/** 等价 Rust 的 `Path::exists()`：跟随符号链接、出任何错都算「不存在」。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
