// 请求路径 → workspace 内的绝对路径（confinement 在这里兑现）
// ---------------------------------------------------------------------------
// 等价移植 Rust 侧那两套 `resolve_workspace_path`：
//   · 读取形态（workspace_read_paths.rs）——目标**必须已存在**，canonicalize 之后比边界。
//     `../` 与绝对路径都允许写，是否越界由 realpath 的结果说了算；Auto 会话可带
//     `allowExternalPaths` 读到根外。
//   · 写入形态（workspace_write_target_path.rs）——目标**可能还不存在**，realpath 无从下手，
//     所以词法上直接拒 `..`，再拿「最近的已存在祖先」去 canonicalize 比边界，最后把缺失的
//     段接回去。写入没有 allowExternalPaths：读到根外只是看见，写到根外是改别人的磁盘。
//
// 三类逃逸各自被哪一步挡住：
//   · 词法逃逸 `../../etc/passwd` —— 读取形态：realpath 解出根外真实路径 → 边界判定拒；
//     写入形态：`hasParentSegment` 当场拒（更早、也更明确）。
//   · 绝对路径 `/etc/passwd` —— 两种形态都会原样保留这个绝对路径（不挂到 root 下），
//     于是边界判定必然失败。
//   · symlink 逃逸（根内一个软链指向根外）—— 词法检查一个字都看不出来，只有 realpath 解开
//     链接后比边界才拦得住。这就是「判定必须基于解析后的真实路径」的全部理由。

import { realpath } from 'node:fs/promises'
import { basename, dirname, sep } from 'node:path'
import { errorText } from './errorText'
import { toSlashPath } from './displayPath'
import { pathExists } from './pathExists'
import {
  hasNulByte,
  hasParentSegment,
  isWithinRoot,
  joinRequestedPath,
  normalizeLexically,
} from './pathContainment'

/** 越界的统一说法（与 Rust 写入侧逐字一致）。 */
const OUTSIDE_WORKSPACE = 'path must stay within the workspace root'

export interface ResolveExistingPathOptions {
  /**
   * Auto 会话的特权：允许目标落在 workspace 之外。默认 false。
   *
   * 只影响**读取**类操作，且必须由宿主按会话档位显式传入——不要给它一个「看起来方便」的
   * 默认真值：这个开关一旦默认打开，confinement 就只剩注释。
   */
  allowExternalPaths?: boolean
}

export interface ResolvedWorkspacePath {
  /** canonicalize 后的绝对路径（符号链接已解开、`..` 已按 POSIX 语义吃掉）。 */
  absolutePath: string
  /**
   * 是否落在 workspace root 之外。只有 `allowExternalPaths` 为真时才可能是 true。
   * 调用方据此决定对外显示绝对路径还是根相对路径（见 displayPath.ts 的 relativeToRoot）。
   */
  external: boolean
}

/**
 * 解析一个**必须已存在**的目标（读取、列目录、搜索、删除、拷贝源……）。
 *
 * 不 trim `requested`：Rust 侧同样按原样用，入参清洗是命令层的事（那里还要处理「不传就用
 * 默认路径」）。这里多做一次 trim 只会让两个宿主对 `" a.txt"` 给出不同结果。
 */
export async function resolveExistingWorkspacePath(
  root: string,
  requested: string,
  options: ResolveExistingPathOptions = {},
): Promise<ResolvedWorkspacePath> {
  if (hasNulByte(requested)) throw new Error('path cannot contain NUL bytes')

  const joined = joinRequestedPath(root, requested)
  let absolutePath: string
  try {
    absolutePath = await realpath(joined)
  } catch (error) {
    throw new Error(
      `path \`${requested}\` is not accessible in workspace \`${toSlashPath(root)}\`: ${errorText(error)}`,
    )
  }

  const external = !isWithinRoot(root, absolutePath)
  if (external && options.allowExternalPaths !== true) {
    throw new Error(`path \`${requested}\` escapes workspace root \`${toSlashPath(root)}\``)
  }
  return { absolutePath, external }
}

/**
 * 解析一个**可能尚不存在**的写入目标（写文件、apply patch、拷贝/移动的目的地）。
 *
 * 返回的绝对路径里，已存在的那一段是 canonicalize 过的（符号链接已解开），尚不存在的那几段
 * 按字面接在后面——它们还没有真实路径可言。
 */
export async function resolveWorkspaceTargetPath(root: string, requested: string): Promise<string> {
  const trimmed = requested.trim()
  if (!trimmed) throw new Error('path (non-empty string) is required')
  if (hasNulByte(trimmed)) throw new Error('path cannot contain NUL bytes')
  // 写入侧对 `..` 是**直接拒**，不是先消再判：目标不存在时没有 realpath 可查，词法层面就是
  // 唯一防线；而按词法消掉 `..` 会与 realpath 的语义分叉（见 pathContainment.ts）。
  if (hasParentSegment(trimmed)) throw new Error('path must not contain `..` components')

  const normalized = normalizeLexically(joinRequestedPath(root, trimmed))
  if (!isWithinRoot(root, normalized)) throw new Error(OUTSIDE_WORKSPACE)
  return resolveExistingAncestor(root, normalized)
}

/**
 * 从目标往上找到最近的已存在祖先，canonicalize 它并比边界，再把缺失的段接回去。
 *
 * 为什么不能只信上面那次词法判定：`<root>/link/new.txt` 里 `link` 可能是指向根外的软链，
 * 词法上它稳稳在 root 下。只有把已存在的那段解成真实路径才看得出来。
 */
async function resolveExistingAncestor(root: string, target: string): Promise<string> {
  if (await pathExists(target)) {
    const canonical = await canonicalize(target, `failed to resolve target path \`${toSlashPath(target)}\``)
    if (!isWithinRoot(root, canonical)) throw new Error(OUTSIDE_WORKSPACE)
    return canonical
  }

  const missing: string[] = []
  let cursor = target
  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor)
    const name = basename(cursor)
    if (!name || parent === cursor) {
      throw new Error(`no existing ancestor found for \`${toSlashPath(target)}\``)
    }
    missing.push(name)
    cursor = parent
  }

  let resolved = await canonicalize(cursor, `failed to resolve ancestor \`${toSlashPath(cursor)}\``)
  if (!isWithinRoot(root, resolved)) throw new Error(OUTSIDE_WORKSPACE)
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    resolved = `${resolved}${sep}${missing[index]}`
  }
  // 再比一次：祖先在根内不代表接回缺失段后仍在根内（root 本身就是那个祖先、而缺失段被
  // 拼成了别的分支时才有意义，但这一步 Rust 也保留着，照做不额外花钱）。
  if (!isWithinRoot(root, resolved)) throw new Error(OUTSIDE_WORKSPACE)
  return resolved
}

async function canonicalize(path: string, failureMessage: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new Error(`${failureMessage}: ${errorText(error)}`)
  }
}
