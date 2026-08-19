// kind → 具体要跑的命令行（`TaskSpec`）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs（已随 T1 删除）的 `resolve_task` /
// `resolve_cargo_check` / `read_package_json` / `ensure_package_script`。
//
// 两条路径：
//   · 四个 package-script kind（test/build/lint/typecheck）—— 读 workspace root 下的
//     package.json，确认对应 script 非空存在，探测包管理器，拼出 `<pm> run <script>`。
//   · `cargo_check` —— 不碰 package.json；依次找 `Cargo.toml`、`apps/desktop/Cargo.toml`、
//     `src-tauri/Cargo.toml`，命中第一个就用它；后两者需要显式 `--manifest-path`，且这个路径
//     必须强制正斜杠（传给 `cargo` 的命令行参数，不是给人看的展示路径，两者规则不同——
//     展示路径走 common/displayPath.ts 的 `toSlashPath` 同一个函数，但用途不同，注意区分）。
//
// **这里的 `apps/desktop/Cargo.toml` 与本仓库已删除的那个桌面端无关**，别顺手删掉它：这三条
// 是在**用户打开的 workspace** 里找 Cargo manifest 的探测顺序，`apps/desktop` 与 `src-tauri`
// 都是 Tauri 项目的惯用布局。它移植自 Rust 侧同一份顺序，当时顺带也命中本仓库自己；今天本仓库
// 命不中了，而对别人的 Tauri 仓库它照样有用。要改成别的顺序是一次**行为改动**，不是文档清理。
//
// 找不到任何一种 Cargo.toml 时的报错文案、package.json 缺 script 时的报错文案，都是从 Rust 侧
// 逐字搬来的英文原文；今天它们是模型可见的对外契约，改文案会改变工具回执。

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { errorText, toSlashPath } from '../common'
import { detectPackageManager } from './packageManager'
import { packageScriptForKind, type TaskKind } from './taskKind'

export interface TaskSpec {
  program: string
  args: string[]
}

/** 等价 Rust `TaskSpec::command()`：`[program, ...args]`，用于结果里的 `command` 字段。 */
export function taskCommand(task: TaskSpec): string[] {
  return [task.program, ...task.args]
}

export async function resolveTask(root: string, kind: TaskKind): Promise<TaskSpec> {
  if (kind === 'cargo_check') return resolveCargoCheck(root)

  const script = packageScriptForKind(kind)
  // 五个 kind 里只有 cargo_check 没有 script，上面已经分流掉；这里必然有值，仅作防御。
  if (!script) throw new Error('task kind does not map to a package script')

  const packageJson = await readPackageJson(root)
  ensurePackageScript(packageJson, script)
  const manager = await detectPackageManager(root, packageJson)

  return { program: manager, args: ['run', script] }
}

async function resolveCargoCheck(root: string): Promise<TaskSpec> {
  if (await isFile(join(root, 'Cargo.toml'))) {
    return { program: 'cargo', args: ['check'] }
  }

  for (const manifest of [join('apps', 'desktop', 'Cargo.toml'), join('src-tauri', 'Cargo.toml')]) {
    if (await isFile(join(root, manifest))) {
      return { program: 'cargo', args: ['check', '--manifest-path', toSlashPath(manifest)] }
    }
  }

  throw new Error(
    'cargo_check requires `Cargo.toml`, `apps/desktop/Cargo.toml`, or `src-tauri/Cargo.toml` in the workspace',
  )
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readPackageJson(root: string): Promise<unknown> {
  const path = join(root, 'package.json')
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
  }
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`failed to parse \`${path}\`: ${errorText(error)}`)
  }
}

function ensurePackageScript(packageJson: unknown, script: string): void {
  const scripts = isRecord(packageJson) ? packageJson.scripts : undefined
  if (!isRecord(scripts)) throw new Error('package.json is missing a `scripts` object')
  const value = scripts[script]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`package.json is missing a non-empty \`${script}\` script`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
