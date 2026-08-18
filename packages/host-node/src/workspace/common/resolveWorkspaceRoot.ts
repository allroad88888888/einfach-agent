// 可信 workspace root 的解析
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs 的 `resolve_workspace_root`。
//
// 为什么不能裸用 process cwd（Rust 侧 P1 安全修复的原话）：宿主进程的 cwd 不可控——桌面 app 里
// 可能是 `/`、app bundle 或 Tauri 工程目录；Node 侧更糟，server 宿主由 systemd/容器拉起时 cwd
// 常常就是 `/`。而这个值是**所有路径限制的可信根**：它一旦是 `/`，confinement 就等于没有。
//
// 解析顺序（与 Rust 逐条对应）：
//   1. 调用方显式传入且非空 → canonicalize 它；
//   2. 没传 → 在 cwd 下跑 `git rev-parse --show-toplevel` 派生仓库根，canonicalize；
//   3. 都得不到 → 抛错（拒绝服务，**绝不**回退到裸 cwd）。
// 最后再拒掉文件系统根——否则整块磁盘都成了「workspace」。

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { errorText } from './errorText'
import { toSlashPath } from './displayPath'
import { isFilesystemRoot } from './pathContainment'

const execFileAsync = promisify(execFile)

export interface ResolveWorkspaceRootOptions {
  /**
   * git 兜底时的工作目录。不传 → `process.cwd()`（等价 Rust 的 `env::current_dir()`）。
   *
   * Rust 侧没有这个参数，因为它的测试直接传 explicit root。Node 侧留这个缝是为了能测**兜底
   * 那条路**本身：改进程 cwd 要 `process.chdir()`，那是进程全局状态，而 vitest 的测试文件是
   * 并行 worker——一个用例 chdir 会把同 worker 里其它用例的相对路径全带偏。参数化是唯一
   * 不引入全局副作用的测法。
   */
  cwd?: string
}

/**
 * 解析可信 workspace root，返回 canonicalize 后的绝对路径。
 *
 * `explicit` 传空串/全空白等同于没传（Rust：`Some(value) if !value.trim().is_empty()`）——
 * 空串若被当成 root 用下去，后面每一次 `root + '/' + x` 都指向文件系统根，且全程不报错。
 */
export async function resolveWorkspaceRoot(
  explicit?: string | null,
  options: ResolveWorkspaceRootOptions = {},
): Promise<string> {
  const trimmed = explicit?.trim()
  const root = trimmed
    ? await canonicalizeRoot(trimmed)
    : await deriveGitRoot(options.cwd ?? process.cwd())
  rejectFilesystemRoot(root)
  return root
}

async function canonicalizeRoot(value: string): Promise<string> {
  try {
    // fs/promises 的 realpath 走的是 uv_fs_realpath（POSIX realpath(3)），与 Rust 的
    // fs::canonicalize 同一份语义。**不要**换成 fs.realpathSync：那个 JS 实现会先按词法消
    // `..`，理由见 pathContainment.ts 的 joinRequestedPath。
    return await realpath(value)
  } catch (error) {
    throw new Error(`failed to resolve workspace root \`${value}\`: ${errorText(error)}`)
  }
}

async function deriveGitRoot(cwd: string): Promise<string> {
  let stdout: string
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
    stdout = result.stdout
  } catch (error) {
    // Rust 把「git 跑不起来」与「git 说这里不是仓库」分成两条消息；Node 的 execFile 两种都是
    // reject，靠 ENOENT 区分。分开是有用的：前者是宿主环境缺 git（装一个就好），后者是调用方
    // 没传 workspace_root（改调用就好），两种出路完全不同。
    if (isCommandMissing(error)) {
      throw new Error(`failed to run git to derive workspace root: ${errorText(error)}`)
    }
    throw new Error(
      'cannot derive workspace root: not inside a git repository (pass workspace_root explicitly): ' +
        stderrText(error).trim(),
    )
  }

  const root = stdout.trim()
  if (!root) throw new Error('git rev-parse returned an empty workspace root')
  return canonicalizeRoot(root)
}

function isCommandMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

function stderrText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string') return stderr
  return stderr instanceof Uint8Array ? Buffer.from(stderr).toString('utf8') : errorText(error)
}

function rejectFilesystemRoot(root: string): void {
  // 无父目录 == 文件系统根。拒绝把整块磁盘当 workspace，否则 confine 形同虚设。
  if (isFilesystemRoot(root)) {
    throw new Error(`refusing to use filesystem root \`${toSlashPath(root)}\` as workspace root`)
  }
}
