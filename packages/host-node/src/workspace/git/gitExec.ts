// 加固后的 `git` 子进程构造与执行：普通命令 + 带上限的流式 diff 读取
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_git_exec.rs（已随 T1 删除）。
//
// 两个执行入口共用**唯一一处** spawn 构造（`startGit`），理由与 Rust 侧的 `git_command` 逐字
// 相同：hardening 一旦分散在两处 spawn 里，就会随着时间各走各的——而漂移出来的那一半是静默的，
// 只有恶意仓库才看得出差别。

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { errorText, readCappedDrain, readCappedStop } from '../common'

/** git diff 的 stderr 小量缓冲上限（stdout 走调用方给的 max_diff_chars 流式 cap）。 */
const MAX_GIT_STDERR_CHARS = 10_000

/** 一次普通 git 调用的全量结果（等价 Rust 的 `GitOutput`）。 */
export interface GitOutput {
  exitCode: number
  stdout: string
  stderr: string
}

/** 一次带上限的流式 diff 读取结果（等价 Rust 的 `GitDiffCapture`）。 */
export interface GitDiffCapture {
  exitCode: number
  text: string
  truncated: boolean
  stderr: string
}

interface StartedGit {
  child: ChildProcess
  /** 进程退出码；被信号杀掉（没有退出码）时为 1，等价 Rust 的 `status.code().unwrap_or(1)`。 */
  exited: Promise<number>
}

/**
 * 构造并起一条已做安全加固的 `git` 子进程。
 *
 *   · `cwd`：统一在解析好的 workspace root 下执行（不是宿主进程的裸 cwd——那个值在 server /
 *     容器里常常是 `/`）。
 *   · `stdin: 'ignore'`（Rust 的 `Stdio::null()`）：git 永远读不到 stdin，杜绝挂在等输入上。
 *   · **不带 `shell`**（Node 默认）：argv 直接交给 execve，参数里的空格/引号/分号不构成拆词，
 *     整条「shell 注入」在这条路上根本不存在。
 *   · env `GIT_LITERAL_PATHSPECS=1`：所有 pathspec 按字面路径处理，`:(top)`、`*.ts`、`:` 等
 *     pathspec 元字符不再被 git 当语法展开——聚焦 review 不混入无关文件。（gitPathspecs.ts 的
 *     confine 校验照旧，这里只改 git 对 pathspec 的解释方式，不放松路径限制。）
 *   · env `GIT_EXTERNAL_DIFF=""`：外部 diff driver 的 env 兜底，配合子命令的 `-c
 *     diff.external=` 与 `--no-ext-diff`，config / env / 命令行三层任何一层都盖不过。
 *   · env `GIT_OPTIONAL_LOCKS=0`：禁止 git 为可选优化去拿锁——否则 `status --short` 遇到过期的
 *     index stat 会顺手刷新并重写 `.git/index`，让号称只读的 review 工具改了仓库元数据。
 */
async function startGit(cwd: string, args: readonly string[]): Promise<StartedGit> {
  const child = spawn('git', [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_LITERAL_PATHSPECS: '1',
      GIT_EXTERNAL_DIFF: '',
      GIT_OPTIONAL_LOCKS: '0',
    },
  })

  // Rust 的 `spawn()` 直接返回 Err，Node 把「起不来」（git 不存在、cwd 不存在）做成异步的
  // 'error' 事件，所以必须先等 'spawn'/'error' 分出胜负，否则后面读管道会等一个永不到来的 EOF。
  try {
    await once(child, 'spawn')
  } catch (error) {
    throw new Error(`failed to run git: ${errorText(error)}`)
  }

  // 退出监听要在**读管道之前**注册：等读完再注册的话，进程可能已经退出、'close' 早已发过，
  // 那个 await 会永远挂着。
  const exited = once(child, 'close').then(([code]) => (typeof code === 'number' ? code : 1))
  // 上面这个 promise 可能先于任何 await 就 reject（子进程报错），先挂个处理器免得变成
  // 未捕获拒绝把宿主进程带崩；真正的错误仍由下面 await 它的地方抛出来。
  void exited.catch(() => {})
  return { child, exited }
}

/**
 * 跑一条普通 git 命令，stdout / stderr 全量读回（等价 Rust 的 `Command::output()`）。
 *
 * 这里**不设上限**：与 Rust 一致。用它的三条（`status --short`、`diff --stat`、
 * `diff --name-only`）输出量与改动文件数同阶，不会像 diff 正文那样被单个大文件顶爆。
 */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitOutput> {
  const { child, exited } = await startGit(cwd, args)
  const out = requireStream(child.stdout, 'stdout')
  const err = requireStream(child.stderr, 'stderr')
  try {
    // 两条管道必须并发排空：只读一条时另一条写满管道缓冲，git 就阻塞在那里等人来读。
    const [stdout, stderr] = await Promise.all([collectText(out), collectText(err)])
    return { exitCode: await exited, stdout, stderr }
  } catch (error) {
    throw new Error(`failed to run git: ${errorText(error)}`)
  }
}

/**
 * 流式跑 `git diff`：stdout 增量读到字符上限即停并杀掉 git（大 diff / lockfile 不会 OOM，也
 * 不会把宿主挂在一份读不完的输出上）。stderr 并发排空、小量缓冲，避免管道撑满卡死 git。
 */
export async function runGitDiffCapped(
  cwd: string,
  args: readonly string[],
  maxChars: number,
): Promise<GitDiffCapture> {
  const { child, exited } = await startGit(cwd, args)
  const out = requireStream(child.stdout, 'stdout')
  const err = requireStream(child.stderr, 'stderr')

  // stderr 的排空必须**先挂起来**再去读 stdout：两条管道任一被写满都会阻塞 git，而 stdout
  // 那一读可能要跑很久。Rust 侧为此专门开了一个线程，Node 这里靠事件循环并发。
  const stderrRead = readCappedDrain(err, MAX_GIT_STDERR_CHARS)
  void stderrRead.catch(() => {})

  let capped
  try {
    capped = await readCappedStop(out, maxChars)
  } catch (error) {
    throw new Error(`failed to read git diff output: ${errorText(error)}`)
  }

  if (capped.truncated) {
    // 到上限就杀掉 git，别让它继续产出 / 挂住宿主。
    child.kill()
  }
  // 关掉 stdout 读端：git 若仍在写会收到 EPIPE/SIGPIPE 自行退出。
  out.destroy()

  let exitCode: number
  try {
    exitCode = await exited
  } catch (error) {
    throw new Error(`failed to wait for git: ${errorText(error)}`)
  }
  let stderr
  try {
    stderr = await stderrRead
  } catch (error) {
    throw new Error(`failed to read git stderr: ${errorText(error)}`)
  }

  return {
    // truncated 是我们主动杀掉 git 造成的，不是 git 出错——报成功退出码，别让调用方误判为失败。
    exitCode: capped.truncated ? 0 : exitCode,
    text: capped.text,
    truncated: capped.truncated,
    stderr: stderr.text,
  }
}

/**
 * 取子进程的管道。`stdio` 明确要了 `pipe`，所以这两条恒非空；保留判断是为了留住 Rust 侧那两句
 * 错误文案（`failed to capture git stdout` / `... stderr`）——真出现时它指向的是装配错误，
 * 而不是让后面一段读操作对着 `undefined` 报一句无关的话。
 */
function requireStream(stream: Readable | null, name: 'stdout' | 'stderr'): Readable {
  if (!stream) throw new Error(`failed to capture git ${name}`)
  return stream
}

/**
 * 读到 EOF 并按 UTF-8 解码。先攒完整份再一次解码，等价 Rust 的
 * `String::from_utf8_lossy(&output.stdout)`——包括「非法字节变 U+FFFD」这一条。
 */
async function collectText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}
