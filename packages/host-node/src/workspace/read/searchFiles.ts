// `search_workspace_files`：按**文件名**过滤、按内容做子串匹配的关键字扫描
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_search.rs（已随 T1 删除）的
// `search_workspace_files_blocking_with_access` + `collect_search_matches` + `maybe_search_file`。
// 与 `rg_search_workspace`（workspace/rg 域）不同：这条命令不依赖外部 ripgrep 二进制，匹配是
// 一条纯子串比较（`line.includes(query)`），**没有** `recursive` 参数——目录目标恒递归到底，
// 只受下面两条独立预算约束。
//
// 【递归恒发生，没有 open/read 失败的软跳过】
// 目录里不带 `recursive` 开关：任何目录目标都会递归穷尽子树（受 maxMatches / 扫描预算约束）。
// 但**打开或读取某个文件失败会让整条命令报错**，不是跳过那一个文件——`searchFileBytes.ts` 的
// `readUpToLimitPlusOne` 向上抛错，这里不捕获。这是 Rust 侧原样的行为（`File::open(..)?` /
// `read_to_end(..)?` 用 `?` 传播），照搬不改：一次遍历大树的搜索如果撞上一个权限不对的文件，
// 整条搜索失败而不是悄悄漏掉那个文件的内容——调用方据此知道结果不完整，而不是误信「搜过了、
// 没找到」。二进制内容 / 非 UTF-8 内容是另一类失败，那两条**是**软跳过（见 `maybeSearchFile`）。
//
// 【truncated 由三条独立判据共同置位，任一为真即真】
//   1. 命中数达 `maxMatches`。
//   2. 扫描过的目录条目数达 `MAX_SEARCH_SCANNED_ENTRIES`（P2 遍历预算：query 生僻/无匹配时
//      maxMatches 永远不会触发，得靠这条防止一次搜索遍历整棵 `node_modules`）。
//   3. 某个参与匹配的文件内容超过 `MAX_SEARCH_FILE_BYTES` 被截断——即使那次截断没有产生任何
//      新增命中，也算「结果可能不完整」。
//
// 【隐藏目录与重目录：跳过即不递归，没有 includeHidden 开关】
// 与 list 不同，search 的 `.` 开头目录**恒跳过**（无法通过参数关闭）；`node_modules` /
// `target` / `dist` 等 `EXCLUDED_DIR_NAMES` 同样整体跳过、不递归进去（`isExcludedDir`，见
// walk.ts）。跳过发生在判定阶段（is_hidden / is_excluded_dir），不进入符号链接逃逸检查那步，
// 因此不会因为一个隐藏目录的名字触发 root 越界报错。

import type { Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  errorText,
  isWithinRoot,
  relativeToRoot,
  resolveExistingWorkspacePath,
  resolveWorkspaceRoot,
  takeCodePoints,
  toSlashPath,
} from '../common'
import { decodeUtf8, rejectBinaryBytes } from './content'
import {
  DEFAULT_SEARCH_MAX_MATCHES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_LINE_CHARS,
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_SCANNED_ENTRIES,
  normalizePositive,
} from './limits'
import { matchesGlob } from './searchGlob'
import { readUpToLimitPlusOne } from './searchFileBytes'
import { splitContentLines } from './searchLines'
import type { SearchWorkspaceFilesResult, WorkspaceSearchMatch } from './types'
import { isExcludedDir, isHidden, sortedReadDir } from './walk'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function nonNegativeIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** 等价 Rust 的 `optional_path_or_default`：给了非空白值才用它（trim 过），否则用默认路径。 */
function optionalPathOrDefault(path: string | undefined, defaultPath: string): string {
  const trimmed = path?.trim()
  return trimmed ? trimmed : defaultPath
}

/** 未给/全空白 → 视为「没传 glob」。等价 Rust `glob.and_then(...)`。 */
function normalizeGlob(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

async function statForSearch(absolutePath: string, displayPath: string): Promise<Stats> {
  try {
    return await stat(absolutePath)
  } catch (error) {
    throw new Error(`path \`${displayPath}\` is not accessible: ${errorText(error)}`)
  }
}

/** 跨递归共享的可变状态：命中数走 `matches.length`，这里只放两个独立标量。 */
interface SearchState {
  truncated: boolean
  scanned: number
}

async function maybeSearchFile(
  root: string,
  filePath: string,
  query: string,
  glob: string | undefined,
  maxMatches: number,
  matches: WorkspaceSearchMatch[],
  state: SearchState,
): Promise<void> {
  const relPath = relativeToRoot(root, filePath)
  const fileName = basename(filePath)
  if (!matchesGlob(relPath, fileName, glob)) return

  const displayPath = toSlashPath(filePath)
  const bytes = await readUpToLimitPlusOne(filePath, displayPath, MAX_SEARCH_FILE_BYTES)

  const fileTruncated = bytes.length > MAX_SEARCH_FILE_BYTES
  const slice = fileTruncated ? bytes.subarray(0, MAX_SEARCH_FILE_BYTES) : bytes
  if (fileTruncated) state.truncated = true

  try {
    rejectBinaryBytes(slice, displayPath)
  } catch {
    return // 二进制内容：软跳过，不影响其余文件（也不算错误）。
  }

  let content: string
  try {
    content = decodeUtf8(slice, fileTruncated, displayPath)
  } catch {
    return // 非 UTF-8：同样软跳过。
  }

  const lines = splitContentLines(content)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!line.includes(query)) continue
    matches.push({
      path: relPath,
      line: takeCodePoints(line, MAX_SEARCH_LINE_CHARS),
      lineNumber: index + 1,
    })
    if (matches.length >= maxMatches) {
      state.truncated = true
      return
    }
  }
}

async function collectSearchMatches(
  root: string,
  dir: string,
  query: string,
  glob: string | undefined,
  maxMatches: number,
  allowExternalPaths: boolean,
  matches: WorkspaceSearchMatch[],
  state: SearchState,
): Promise<void> {
  if (matches.length >= maxMatches) {
    state.truncated = true
    return
  }

  for (const path of await sortedReadDir(dir)) {
    if (state.scanned >= MAX_SEARCH_SCANNED_ENTRIES) {
      state.truncated = true
      return
    }
    state.scanned += 1

    if (isHidden(path)) continue

    let resolved: string
    try {
      resolved = await realpath(path)
    } catch {
      continue
    }
    if (!allowExternalPaths && !isWithinRoot(root, resolved)) continue

    let stats: Stats
    try {
      stats = await lstat(path)
    } catch {
      continue
    }

    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (isExcludedDir(path)) continue
      await collectSearchMatches(root, path, query, glob, maxMatches, allowExternalPaths, matches, state)
    } else if (stats.isFile()) {
      await maybeSearchFile(root, path, query, glob, maxMatches, matches, state)
    }
    // 符号链接（无论指向文件还是目录）落进两个分支之外：既不递归也不参与内容匹配。

    if (matches.length >= maxMatches) {
      state.truncated = true
      return
    }
    if (state.scanned >= MAX_SEARCH_SCANNED_ENTRIES) {
      state.truncated = true
      return
    }
  }
}

/**
 * `search_workspace_files`。入参是 snake_case（core 的 `toTauriSearchInput` 已经转好），
 * 但未经校验，收窄在本函数内完成。
 */
export async function searchWorkspaceFiles(
  args: Record<string, unknown>,
): Promise<SearchWorkspaceFilesResult> {
  const root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))

  const query = (stringArg(args, 'query') ?? '').trim()
  if (!query) throw new Error('query (non-empty string) is required')

  const requested = optionalPathOrDefault(stringArg(args, 'path'), '.')
  const allowExternalPaths = args.allow_external_paths === true
  const { absolutePath: target } = await resolveExistingWorkspacePath(root, requested, {
    allowExternalPaths,
  })
  const displayPath = toSlashPath(target)

  const stats = await statForSearch(target, displayPath)
  const glob = normalizeGlob(stringArg(args, 'glob'))
  const maxMatches = normalizePositive(
    nonNegativeIntegerArg(args, 'max_matches'),
    DEFAULT_SEARCH_MAX_MATCHES,
    MAX_SEARCH_MATCHES,
  )

  const matches: WorkspaceSearchMatch[] = []
  const state: SearchState = { truncated: false, scanned: 0 }

  if (stats.isFile()) {
    await maybeSearchFile(root, target, query, glob, maxMatches, matches, state)
  } else if (stats.isDirectory()) {
    await collectSearchMatches(root, target, query, glob, maxMatches, allowExternalPaths, matches, state)
  } else {
    throw new Error(`path \`${displayPath}\` is neither a file nor a directory`)
  }

  return { matches, truncated: state.truncated }
}

/** `search_workspace_files` 的 handler 工厂。 */
export function createSearchWorkspaceFilesHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => searchWorkspaceFiles(args)
}
