// 目录遍历时的条目枚举顺序与跳过规则
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_walk.rs。`list_workspace_files`（listFiles.ts）与
// `search_workspace_files`（searchFiles.ts）共用同一套「按什么顺序枚举、跳过哪些名字」的判据，
// 因此单独收成一个文件而不是分别抄一遍。

import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { errorText, toSlashPath } from '../common'
import { EXCLUDED_DIR_NAMES } from './limits'

/**
 * 列出目录下的直接子路径（绝对路径），按文件名小写升序排列。
 * 等价 Rust 的 `sorted_read_dir`：`fs::read_dir` 收集后按 `file_name().to_lowercase()` 比较。
 *
 * **不捕获错误**：`readdir` 失败（目录不可读/在扫描途中被删）直接向上抛，等价 Rust 那边
 * `fs::read_dir(dir)?` 与遍历途中 `entry?` 失败时让整条命令报错，而不是跳过这个子树。
 */
export async function sortedReadDir(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    throw new Error(`failed to read directory \`${toSlashPath(dir)}\`: ${errorText(error)}`)
  }
  return names
    .map((name) => ({ key: name.toLowerCase(), path: join(dir, name) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.path)
}

/**
 * 该名字是否属于要整体跳过、不递归进去的「重目录」（`node_modules` / `target` / …）。
 * 等价 Rust 的 `is_excluded_dir`：只比对文件名分量，不看完整路径。
 */
export function isExcludedDir(path: string): boolean {
  return EXCLUDED_DIR_NAMES.includes(basename(path))
}

/**
 * 该名字是否算隐藏（以 `.` 开头）。等价 Rust 的 `is_hidden`。
 *
 * Rust 版本还排除了 `.` 与 `..` 本身——Node 的 `readdir` 从不返回这两个特殊条目，所以这里
 * 不需要那两条判断，行为仍然等价。
 */
export function isHidden(path: string): boolean {
  return basename(path).startsWith('.')
}
