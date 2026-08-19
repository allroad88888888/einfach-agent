// `list_workspace_files`：目录条目列举与递归收集
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_list.rs（已随 T1 删除）的
// `list_workspace_files_blocking_with_access` + `collect_entries` + `to_entry`。
//
// 【symlink：列出但不进去，前提是目标存在且（未开 allowExternalPaths 时）落在根内】
// 每个子路径先 `realpath`（对齐 Rust 的 `fs::canonicalize`）：
//   · 目标不存在（断链）→ realpath 失败 → **整条都不列**，不只是不递归。
//   · 目标存在但落在根外、且 `allowExternalPaths` 不为真 → 同样**不列**（这就是 symlink 逃逸
//     检查——它比对的是 realpath 之后的真实目标，不是 symlink 自身的路径）。
//   · 目标存在且（在根内，或 allowExternalPaths 为真）→ 列出，条目类型来自 `lstat`（不跟随），
//     因此是 `"symlink"`；随后 `stats.isDirectory()` 在 lstat 结果上恒为 false（lstat 报告的是
//     链接本身的类型），所以**永不**递归进符号链接，即使它指向一个目录、即使 recursive 为真。
//
// 【maxEntries：命中即整体停止遍历，不是「这次不多列了」】
// 判定 `entries.length >= maxEntries` 在 hidden 过滤与 realpath 越界过滤**之后**——被这两条
// 过滤掉的条目不计入 maxEntries，也不会触发 truncated。一旦命中，`truncated` 置真并立即向上
// 冒泡（每层递归入口都先查 `state.truncated`），不会继续数「还剩多少」，也不会见好就收去补齐
// 当前目录剩下的条目。
//
// 【includeHidden：按目录名逐级过滤，隐藏目录里的非隐藏文件因此整体不可见】
// 判定只看当前条目自己的文件名是否以 `.` 开头；目录同样受此约束。含义是：一个隐藏目录一旦被
// 跳过（`continue`），它整棵子树（包括子树里非隐藏的文件）都不会被枚举到——不是「隐藏目录本身
// 不列、但递归照常」。`includeHidden: true` 时隐藏目录才会被列出并（recursive 时）递归进去。

import type { Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import {
  errorText,
  isWithinRoot,
  relativeToRoot,
  resolveExistingWorkspacePath,
  resolveWorkspaceRoot,
  toSlashPath,
} from '../common'
import { DEFAULT_LIST_MAX_ENTRIES, MAX_LIST_ENTRIES, normalizePositive } from './limits'
import type { ListWorkspaceFilesResult, WorkspaceFileEntry } from './types'
import { isHidden, sortedReadDir } from './walk'
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

async function statForList(absolutePath: string, displayPath: string): Promise<Stats> {
  try {
    return await stat(absolutePath)
  } catch (error) {
    throw new Error(`path \`${displayPath}\` is not accessible: ${errorText(error)}`)
  }
}

function toEntry(root: string, path: string, stats: Stats): WorkspaceFileEntry {
  const entryType = stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other'
  const entry: WorkspaceFileEntry = { path: relativeToRoot(root, path), type: entryType }
  if (stats.isFile()) entry.size = stats.size
  return entry
}

/** 跨递归调用共享的「已经截断」标记。等价 Rust 的 `&mut bool` 出参。 */
interface WalkState {
  truncated: boolean
}

async function collectEntries(
  root: string,
  dir: string,
  recursive: boolean,
  includeHidden: boolean,
  maxEntries: number,
  allowExternalPaths: boolean,
  entries: WorkspaceFileEntry[],
  state: WalkState,
): Promise<void> {
  if (state.truncated) return

  for (const path of await sortedReadDir(dir)) {
    if (!includeHidden && isHidden(path)) continue

    let resolved: string
    try {
      resolved = await realpath(path)
    } catch {
      continue // 断链或读取途中消失：整条跳过，不只是不递归。
    }
    if (!allowExternalPaths && !isWithinRoot(root, resolved)) continue

    if (entries.length >= maxEntries) {
      state.truncated = true
      return
    }

    let stats: Stats
    try {
      stats = await lstat(path)
    } catch {
      continue
    }
    entries.push(toEntry(root, path, stats))

    // `stats` 来自 lstat：符号链接的 `isDirectory()` 恒为 false，因此这个条件本身已经在
    // 排除符号链接；`!stats.isSymbolicLink()` 是与 Rust 逐行对齐的显式写法，不是多余判断。
    if (recursive && stats.isDirectory() && !stats.isSymbolicLink()) {
      await collectEntries(
        root,
        path,
        recursive,
        includeHidden,
        maxEntries,
        allowExternalPaths,
        entries,
        state,
      )
      if (state.truncated) return
    }
  }
}

/**
 * `list_workspace_files`。入参是 snake_case（core 的 `toTauriListInput` 已经转好），
 * 但未经校验，收窄在本函数内完成。
 */
export async function listWorkspaceFiles(
  args: Record<string, unknown>,
): Promise<ListWorkspaceFilesResult> {
  const root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))
  const requested = optionalPathOrDefault(stringArg(args, 'path'), '.')
  const allowExternalPaths = args.allow_external_paths === true

  const { absolutePath: dir } = await resolveExistingWorkspacePath(root, requested, {
    allowExternalPaths,
  })
  const displayPath = toSlashPath(dir)

  const stats = await statForList(dir, displayPath)
  if (!stats.isDirectory()) throw new Error(`path \`${displayPath}\` is not a directory`)

  const recursive = args.recursive === true
  const includeHidden = args.include_hidden === true
  const maxEntries = normalizePositive(
    nonNegativeIntegerArg(args, 'max_entries'),
    DEFAULT_LIST_MAX_ENTRIES,
    MAX_LIST_ENTRIES,
  )

  const entries: WorkspaceFileEntry[] = []
  const state: WalkState = { truncated: false }
  await collectEntries(root, dir, recursive, includeHidden, maxEntries, allowExternalPaths, entries, state)

  return { entries, truncated: state.truncated }
}

/** `list_workspace_files` 的 handler 工厂。 */
export function createListWorkspaceFilesHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => listWorkspaceFiles(args)
}
