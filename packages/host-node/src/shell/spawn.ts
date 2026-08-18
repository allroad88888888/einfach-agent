// shell 子进程的启动：拼命令行、注入 env、按平台配置进程组
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_spawn.rs。三处 Node 与 Rust 的默认值相反，逐条写在下面，
// 因为每一处照抄写法都会得到不同的行为。

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { errorText } from '../workspace/common'
import { ShellSetupError, type ShellSpec } from './types'

/** 已经起来的子进程，附带两条一定存在的管道。 */
export interface SpawnedShell {
  child: ChildProcess
  stdout: Readable
  stderr: Readable
}

export async function spawnShellCommand(
  shell: ShellSpec,
  command: string,
  cwd: string,
  childEnv: Record<string, string> | undefined,
): Promise<SpawnedShell> {
  const child = spawn(shell.program, [...shell.args, command], {
    cwd,
    // stdin 给 null 设备：命令读 stdin 时立刻拿到 EOF 而不是永久等待。
    // 这条与全局那条「后台跑 CLI 必须 `< /dev/null`」是同一个道理，只是位置在宿主这边。
    stdio: ['ignore', 'pipe', 'pipe'],
    // Rust 的 `Command::envs()` 是**往继承来的环境里加**；Node 的 `env` 选项是**整份替换**。
    // 照抄写法会让子进程丢掉 PATH，症状是「传了 env 的命令找不到任何可执行文件」。
    env: childEnv === undefined ? undefined : { ...process.env, ...childEnv },
    // Rust 用 `process_group(0)`（setpgid）把子进程放进新进程组，好让超时/清理能一次
    // 覆盖它派生的后台进程。Node 只暴露 `detached`，在 Unix 上是 setsid——除了新进程组
    // 还额外脱离控制终端。对本用法没有差别：stdin 是 null 设备、stdout/stderr 是管道，
    // 子进程本来就没有可用的 tty。Windows 上 `detached` 的语义完全不同（新建控制台窗口），
    // 而 Rust 在非 unix 分支什么都不做，所以这里也不设。
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  await new Promise<void>((resolve, reject) => {
    // Node 的 spawn 失败（shell 不存在、cwd 不可执行）是**异步的 'error' 事件**，不是同步抛出。
    // 不等这一下的话，`failed to spawn shell` 会变成一次「起来了但立刻 EOF」的空结果。
    child.once('spawn', resolve)
    child.once('error', (error) => {
      reject(new ShellSetupError(`failed to spawn shell \`${shell.display}\`: ${errorText(error)}`))
    })
  })

  // 起来之后仍可能冒出 'error'（例如 kill 时的 EPERM）。ChildProcess 是 EventEmitter，
  // 没有 listener 的 'error' 会成为未捕获异常直接掀翻宿主进程。Rust 那边这类失败是
  // `io::Result`，调用点已经决定忽略（`let _ = kill_child(child)`），所以这里也吞掉。
  child.on('error', () => {})

  const { stdout, stderr } = child
  // 与 Rust 的 `ok_or_else(...)?` 同级：这不是「命令失败」，是宿主自己的 bug，
  // 所以抛普通 Error（会变成桥调用失败），不抛 ShellSetupError。
  if (!stdout) throw new Error('failed to capture child stdout')
  if (!stderr) throw new Error('failed to capture child stderr')
  return { child, stdout, stderr }
}
