// 拼 rg 参数并 spawn 子进程
// ---------------------------------------------------------------------------
// 参数顺序对齐 Rust 的 `spawn_rg`：`--json --color never --line-number --column --with-filename
// --max-filesize <RG_MAX_FILESIZE>`，随后按开关追加 `--fixed-strings` / `--ignore-case` /
// `--context <N>`，再逐个 `--glob <g>`，最后 `--regexp <query> <target>`。cwd = root，
// stdin 关闭（rg 不需要标准输入，关掉避免它意外挂在等待输入上）。
//
// **rg 缺失时的错误**：Node 的 `spawn()` 不会同步抛错——缺失的可执行文件会异步触发子进程的
// `error` 事件（`err.code === 'ENOENT'`）。这里等到确认 spawn 成功（`spawn` 事件）或失败
// （`error` 事件）才 resolve/reject，对齐 Rust `Command::spawn()` 返回 `Result` 就已经知道
// 成不成功的语义。spawn 成功之后仍保留一个常驻 `error` 监听（吞掉，不重新 reject）——Node 要求
// 子进程对象必须有人监听 `error`，否则后续的异步错误会变成未捕获异常，直接打断整个宿主进程。
//
// 错误文案：前半句 `` failed to spawn `rg`: <系统错误> `` 是 Rust 原文（`format!("failed to
// spawn \`rg\`: {err}")`）逐字保留；ENOENT 时追加的安装指引是**没有 Rust 对应物**的新增内容
// ——桌面端只会把裸系统错误糊给用户，这张卡明确要求「让人一眼知道该装什么」，所以用中文补一句。

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { RG_MAX_FILESIZE } from './constants'
import { errorText } from '../common'

/** stdin 关闭（`null`），stdout/stderr 是管道——对应下面 spawn 时传的 `stdio` 元组。 */
export type RgChildProcess = ChildProcessByStdio<null, Readable, Readable>

export interface SpawnRgOptions {
  root: string
  target: string
  query: string
  regex: boolean
  caseSensitive: boolean
  globs: readonly string[]
  contextLines: number
  /** 测试用可覆盖的可执行文件名；默认 `rg`，与 Rust 侧硬编码的命令名一致。 */
  binary?: string
}

function buildArgs(options: SpawnRgOptions): string[] {
  const args = [
    '--json',
    '--color',
    'never',
    '--line-number',
    '--column',
    '--with-filename',
    '--max-filesize',
    RG_MAX_FILESIZE,
  ]
  if (!options.regex) args.push('--fixed-strings')
  if (!options.caseSensitive) args.push('--ignore-case')
  if (options.contextLines > 0) args.push('--context', String(options.contextLines))
  for (const glob of options.globs) args.push('--glob', glob)
  args.push('--regexp', options.query, options.target)
  return args
}

function missingBinaryHint(binary: string, error: unknown): string {
  const base = `failed to spawn \`${binary}\`: ${errorText(error)}`
  const isMissing = (error as { code?: unknown } | null)?.code === 'ENOENT'
  if (!isMissing) return base
  return (
    `${base}（未找到 \`${binary}\` 可执行文件，请安装 ripgrep 后重试：` +
    'https://github.com/BurntSushi/ripgrep#installation ' +
    '，例如 `brew install ripgrep` 或 `apt install ripgrep`）'
  )
}

/**
 * spawn rg 子进程；成功后返回已确认存活的 `RgChildProcess`（stdout/stderr 保证是管道，因为
 * 我们自己传的 stdio 配置）。失败（含二进制缺失）以 reject 呈现，交由调用方转成本域统一的
 * `failedRgResult`——与 Rust 侧「spawn 失败即软失败，不是命令级 Err」的语义一致。
 */
export function spawnRg(options: SpawnRgOptions): Promise<RgChildProcess> {
  const binary = options.binary ?? 'rg'
  return new Promise((resolve, reject) => {
    const child = spawn(binary, buildArgs(options), {
      cwd: options.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    child.on('error', (error) => {
      if (settled) return // 常驻监听：spawn 成功后的后续错误只吞掉，不再二次 reject/settle。
      settled = true
      reject(new Error(missingBinaryHint(binary, error)))
    })
    child.once('spawn', () => {
      settled = true
      resolve(child)
    })
  })
}
