// MCP 子进程的拉起、强制终止与 stderr 排空
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_session_spawn.rs 的 spawn 段与 mcp_process.rs 的
// `kill_child` / `configure_child_process` / `drain_stderr` / `terminate_spawned_child`。
//
// ═══ 这是本域唯一的高危动作 ═══
// `command` 与 `args` 来自 `~/.webAgent/config.json` 的 `mcp.servers` 段（config 域的
// mcpConfigCommands.ts），那是**用户可编辑、且可被"导入一份配置"写进去**的数据。所以：
//   · 一律 `spawn(command, args)`，**永不** `shell: true`、永不拼命令行字符串。Node 的 spawn
//     默认就不过 shell，argv 直接进 execve——`;`、反引号、`$(...)`、换行在参数里都只是普通字符。
//     拼成一条字符串再交给 shell，配置里任何一个特殊字符就是一次命令注入，而这份配置的来源
//     恰好包括"从聊天里粘一段 mcpServers JSON 导进来"。
//   · 起进程之前那道**人看着点确认**的门在应用层（apps/web/src/mcp/stdioLaunchConsent.ts，
//     指纹绑 command/args/cwd/env）。本层是它下游的执行者，不重复判也不放宽。

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { errorText } from '../workspace/common'
import { McpCommandError } from './errors'
import type { McpConnectInput } from './inputs'

export interface SpawnedMcpChild {
  child: ChildProcess
  pid: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
}

/**
 * 拉起 MCP server 子进程。
 *
 * 失败分两种 kind，**不能合并**——tools/mcp 的失败分类器只认 `command_spawn_failed` 判永久失败：
 *   · `command_spawn_failed` —— OS 拒绝启动这条命令（找不到、不可执行、没权限）。重连不会自愈，
 *     必须改配置。
 *   · `spawn_failed` —— 进程**已经起来了**，之后宿主自己的装配出了问题（管道没拿到）。可重试。
 */
export async function spawnMcpChild(input: McpConnectInput): Promise<SpawnedMcpChild> {
  const child = launch(input)

  await new Promise<void>((resolve, reject) => {
    // 起不来的命令**在 Node 里是异步的 'error' 事件**，不是同步抛出。不等这一下的话，一条
    // 根本没起来的命令会被当成「连上了但立刻 EOF」，报出来的是 transport 错误而不是
    // `command_spawn_failed`，于是一个改配置才能修的问题会被无限重连。
    child.once('spawn', resolve)
    child.once('error', (error) => reject(commandSpawnFailed(input.serverId, error)))
  })

  // 起来之后仍可能冒出 'error'（kill 时的 EPERM 之类）。ChildProcess 是 EventEmitter，
  // 没有 listener 的 'error' 会成为未捕获异常直接掀翻宿主进程。Rust 那边这类失败是
  // `io::Result` 且调用点已决定忽略（`let _ = kill_child(child)`），这里同样吞掉。
  child.on('error', () => {})

  const { stdin, stdout, stderr } = child
  if (!stdin || !stdout || !stderr) {
    await terminateSpawnedChild(child)
    throw new McpCommandError(
      'spawn_failed',
      'failed to capture MCP server stdio',
    ).forServer(input.serverId)
  }
  // stdin 的写失败会由 writer 的 write 回调接住，但流本身的 'error' 事件仍需要一个 listener。
  stdin.on('error', () => {})

  const pid = child.pid
  if (pid === undefined) {
    await terminateSpawnedChild(child)
    throw new McpCommandError(
      'spawn_failed',
      'failed to read MCP server pid',
    ).forServer(input.serverId)
  }

  // ═══ unref：让「有一个 MCP 会话」不等于「宿主进程永远退不掉」 ═══
  // Rust 里一个会话是 3 条线程，而进程在 main 返回时就退出、不等线程；Node 里一个活着的
  // ChildProcess 和它的三条管道**各自都是 ref 的 handle**，任何一个都能把 event loop 钉住。
  // 不 unref 的实测结果：CLI 宿主跑完一轮之后永远不退出（已用探针复现）。unref 之后进程能
  // 正常退出，而 exitNet.ts 的退出兜底会在那一刻把子进程整组杀掉——没有孤儿。
  child.unref()
  unrefStream(stdin)
  unrefStream(stdout)
  unrefStream(stderr)

  return { child, pid, stdin, stdout, stderr }
}

/**
 * 真正的 `spawn` 调用。
 *
 * **同步抛出也要落成 `command_spawn_failed`**：Node 对 command / args / env / cwd 里的 NUL 字节
 * 是**同步抛 `TypeError(ERR_INVALID_ARG_VALUE)`**（已实测四处全是同步），而 Rust 的
 * `Command::spawn()` 对同一份输入返回 `Err(InvalidInput)`，走的正是 `command_spawn_failed`。
 * 不接这一下，同一份坏配置在两个宿主上会得到不同结局：Node 侧抛出的是一个没有 `kind` 的裸
 * TypeError，而失败分类器对没有 kind 的错误一律判**暂时失败**——于是一份永远不可能起来的配置
 * 会被无限重连。（`mcp_validation.rs` 的 `validate_command` 也只判空、不判 NUL，两边同源。）
 */
function launch(input: McpConnectInput): ChildProcess {
  try {
    return spawn(input.command, input.args, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Rust 的 `Command::envs()` 是**往继承来的环境里加**，Node 的 `env` 选项是**整份替换**。
      // 照抄写法会让子进程丢掉 PATH，症状是「配了 env 的 MCP server 一律起不来」。
      // （与 shell/spawn.ts 那处是同一个坑，同一个解法。）
      env: Object.keys(input.env).length === 0
        ? undefined
        : { ...process.env, ...input.env },
      // Rust 是 `process_group(0)`（setpgid）：把子进程放进自己的进程组，好让清理能一次覆盖
      // **它派生的孙进程**——MCP server 常常是 `npx` 起一个真正的实现进程。Node 只暴露
      // `detached`，Unix 上是 setsid（新进程组 + 脱离控制终端），对本用法没有差别：stdio 三条
      // 全是管道，子进程本来就没有可用的 tty。Windows 上 `detached` 语义完全不同（新建控制台
      // 窗口），而 Rust 在非 unix 分支什么都不做，所以这里也不设。
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    throw commandSpawnFailed(input.serverId, error)
  }
}

function commandSpawnFailed(serverId: string, error: unknown): McpCommandError {
  return new McpCommandError(
    'command_spawn_failed',
    `failed to start MCP server \`${serverId}\`: ${errorText(error)}`,
  ).forServer(serverId)
}

/**
 * 子进程的 stdio 在运行时是 `net.Socket` / `Pipe`（都有 `unref`），但 `ChildProcess` 的类型
 * 只承诺 `Readable` / `Writable`（没有 `unref`）。这不是类型定义的疏漏——`stdio` 配成
 * `'inherit'` 或文件描述符时确实拿不到可 unref 的对象。这里已经写死了 `'pipe'`，所以运行时
 * 一定有；写成可选调用而不是断言，是为了让「将来有人把 stdio 改成别的」不会变成运行时崩溃。
 */
function unrefStream(stream: Readable | Writable): void {
  ;(stream as { unref?: () => void }).unref?.()
}

/**
 * 杀进程。**先杀整个进程组**（`kill(-pid)`），覆盖 MCP server 自己拉起的孙进程；
 * 进程组不在了就回落到杀直接子进程。返回是否送出了信号。
 *
 * 【为什么直接 SIGKILL、没有 SIGTERM 那一步】Rust 的 `kill_child` 同样是直接 SIGKILL。
 * 优雅退出的机会**已经给过了**，只是不靠信号：关闭流程是「先关 stdin → 等 grace（默认 500ms）
 * → 还活着才强杀」，而关 stdin 正是 MCP stdio 传输里"请你退出"的规范信号，守规矩的 server
 * 读到 EOF 就会自己收尾。到了这一步的进程是**已经无视过一次正常退出请求**的，再发一次
 * SIGTERM 只是把清理时间翻倍，换不来更干净的结果。
 *
 * pid 复用不是隐患：只要组里还有活着的成员，这个 pgid 就不会被分配给别人；组空了则
 * `kill(-pid)` 直接 ESRCH，伤不到无关进程。
 */
export function killChildGroup(child: ChildProcess): boolean {
  const pid = child.pid
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return true
    } catch {
      // 组已消失或无权限：退回到直接子进程。
    }
  }
  try {
    return child.kill('SIGKILL')
  } catch {
    return false
  }
}

/** 等价 Rust 的 `terminate_spawned_child`：杀掉并收尸，用于 spawn 中途失败的回滚。 */
export async function terminateSpawnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  killChildGroup(child)
  await exited
}

/**
 * 排空 stderr。
 *
 * **必须排**，这不是可选项：管道缓冲只有几十 KiB，读端一停写端就阻塞在 write 上，一台话多的
 * MCP server 会就此卡死，症状是「所有请求超时」而不是「它日志太多」。
 *
 * **有意不移植 Rust 的 `TailBuffer`**：那 16 KiB 尾缓冲是个**只写不读的累积器**——全仓 grep
 * 过，`TailBuffer` 只有 `new` 和 `push`，没有任何读出口，唯一的消费点是往里塞一句「某线程
 * panic 了」的字符串（而 Node 没有线程可 panic）。Rust 自己的测试还专门断言它绝不能跨命令
 * 边界出现。移过来就是每个会话白占 16 KiB 且永远没人看。已作为移植发现记录。
 */
export function drainStderr(stderr: Readable): void {
  stderr.resume()
}

/**
 * 把退出码写成 Rust `{:?}` 打印 `Option<i32>` 的样子：`Some(0)` / `None`。
 *
 * **这句话是照搬，不是我们想要的措辞**：它会原样进 `mcp-stdio-close` 事件的 message，一路
 * 走到前端的失败提示里，用户看到的是「(exit code Some(1))」。要改得两个宿主一起改，本卡不动。
 * 已作为移植发现记录。
 */
export function formatExitCode(code: number | null): string {
  return code === null ? 'None' : `Some(${code})`
}
