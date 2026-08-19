// 一条 MCP stdio 会话：请求收发、传输关闭、进程收尾
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_session.rs（已随 T1 删除）的 `McpSession`（`request` / `ensure_running` /
// `resolve_timeout` / `close`）与 mcp_process.rs 的 `watch_child_process`。
//
// 会话是本域唯一有状态的东西，四个标志各管一件事、**不能合并**：
//   closing        —— 是我们主动在关（disconnect）。用来让生命周期事件闭嘴：主动关闭时的
//                     「stdin 关了 / 进程退了 / stdout EOF」都不是意外掉线。
//   transportClosed —— 管道已经不可用。用来在**发出请求之前**就失败，而不是让它挂到超时。
//   childExited    —— 子进程已退出（'exit' 事件到过）。
//   closePromise   —— close 已被调用过。close 是幂等的且**记住结局**（Rust 是 close_outcome），
//                     第二次调用返回第一次的答案，而不是对着一个已经没了的进程再算一遍。

import type { ChildProcess } from 'node:child_process'
import { formatExitCode, killChildGroup } from './childProcess'
import { McpCommandError } from './errors'
import type { McpLifecycleNotifier } from './lifecycle'
import { PendingRequests, type RpcReply } from './pending'
import { normalizeTimeout } from './validation'
import type { McpStdinWriter } from './writer'

/** 关闭的结局。`exitCode` 为 null 表示被信号杀死（对齐 Rust `ExitStatus::code() == None`）。 */
export interface McpCloseOutcome {
  exitCode: number | null
  forcedKill: boolean
}

export interface McpSessionParts {
  serverId: string
  sessionToken: string
  pid: number
  defaultTimeoutMs: number
  child: ChildProcess
  writer: McpStdinWriter
  lifecycle: McpLifecycleNotifier
  /** 从退出兜底名单里摘除自己。会话关掉之后再兜底就是对一个已死 pid 发信号。 */
  untrackFromHostExit: () => void
}

export class McpSession {
  readonly serverId: string
  readonly sessionToken: string
  readonly pid: number
  readonly defaultTimeoutMs: number
  readonly pending = new PendingRequests()

  private readonly child: ChildProcess
  private readonly writer: McpStdinWriter
  private readonly lifecycle: McpLifecycleNotifier
  private readonly untrackFromHostExit: () => void

  /** 从 1 开始，与 Rust 的 `AtomicU64::new(1)` + `fetch_add`（返回旧值）一致。 */
  private nextRequestId = 1
  private closing = false
  private transportClosed = false
  private childExited = false
  private childExitCode: number | null = null
  private closePromise: Promise<McpCloseOutcome> | undefined

  constructor(parts: McpSessionParts) {
    this.serverId = parts.serverId
    this.sessionToken = parts.sessionToken
    this.pid = parts.pid
    this.defaultTimeoutMs = parts.defaultTimeoutMs
    this.child = parts.child
    this.writer = parts.writer
    this.lifecycle = parts.lifecycle
    this.untrackFromHostExit = parts.untrackFromHostExit
    this.child.once('exit', (code) => this.handleChildExit(code))
    // 进程可能在**会话装配完成之前**就退了（起来了立刻崩）。'exit' 已经发过，上面那个 listener
    // 收不到，于是 `childExited` 会一直是 false——请求不会以 `process_exited` 快速失败，而是
    // 走 stdout EOF 那条路报 `transport_closed`，说的是另一件事。这里补一次。
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      // 用微任务而不是同步调：构造函数返回之前 sessionSpawn 还没把 stdout 接上，同步发
      // close 事件会排在「连接建立」之前。
      queueMicrotask(() => this.handleChildExit(this.child.exitCode))
    }
  }

  /** 供 lifecycle 通知器查询「是不是我们主动在关」。 */
  isClosing(): boolean {
    return this.closing
  }

  /**
   * 传输走到头了：置标志、让全部在途请求以此理由失败、发一次 close 事件。
   *
   * `closeWriter` 只有**子进程退出**那条路才置真（Rust 的 `watch_child_process` 里那句
   * `drop(lock_recover(&writer).take())`）——进程都没了，stdin 留着只会让后续写入拿到
   * 一个更难懂的 EPIPE 而不是「stdin is closed」。stdout EOF 那条路不关 stdin：进程可能还活着，
   * 只是关掉了自己的 stdout。
   */
  closeTransport(message: string, closeWriter = false): void {
    this.transportClosed = true
    if (closeWriter) this.writer.close()
    this.pending.failAll({ kind: 'transport', message })
    this.lifecycle.closed(message)
  }

  /** 请求方给的超时：不传用会话默认，传了走归一化（0 报错、超上限钳住）。 */
  resolveTimeout(requested: number | undefined, fieldName: string): number {
    if (requested === undefined) return this.defaultTimeoutMs
    return normalizeTimeout(requested, this.defaultTimeoutMs, fieldName, this.serverId)
  }

  /** 发一次 JSON-RPC 请求并等答案。四种失败各自一个 kind，见下面各分支。 */
  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.ensureRunning()
    const id = this.nextRequestId
    this.nextRequestId += 1

    // **先登记再写**，顺序不能反：响应可能在 write 的回调之前就到（对端快、事件循环恰好先跑
    // 'data'），后登记会让那条答案变成一条无主响应被丢弃，请求挂到超时。
    // Rust 在这里还会再查一次 closing/transportClosed，因为它的 ensure_running 在锁外、
    // 两次检查之间别的线程能插进来；Node 里从 ensureRunning 到 register 之间没有 await，
    // 中途插不进任何东西，所以不重复判。
    const reply = new Promise<RpcReply>((resolve) => this.pending.register(id, resolve))

    try {
      await this.writer.write({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      this.pending.remove(id)
      throw new McpCommandError(
        'transport_error',
        `failed to write MCP request \`${method}\`: ${error instanceof Error ? error.message : String(error)}`,
      ).forServer(this.serverId)
    }

    const settled = await this.awaitReply(id, reply, timeoutMs)
    if (settled === TIMED_OUT) {
      throw new McpCommandError(
        'timeout',
        `MCP request \`${method}\` timed out after ${timeoutMs} ms`,
      ).forServer(this.serverId)
    }
    if (settled.kind === 'result') return settled.value
    if (settled.kind === 'transport') {
      throw new McpCommandError(
        'transport_closed',
        `MCP request \`${method}\` failed: ${settled.message}`,
      ).forServer(this.serverId)
    }
    throw new McpCommandError(
      'rpc_error',
      `MCP request \`${method}\` failed: ${settled.failure.message} (${settled.failure.code})`,
      { serverId: this.serverId, rpcCode: settled.failure.code, data: settled.failure.data },
    )
  }

  /**
   * 发一条通知（无 id，因此没有答案可等）。
   *
   * `params` 不传时**整个键都不出现**，而不是 `params: null`——JSON-RPC 里两者不同，
   * 而 `notifications/initialized` 恰好是握手的最后一步，一台严格的 server 有理由拒收畸形的它。
   * Rust 那边是手工拼 `Map` 并只在有 params 时 insert，同一件事。
   */
  async notify(method: string, params?: unknown): Promise<void> {
    const message = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params }
    try {
      await this.writer.write(message)
    } catch (error) {
      throw new McpCommandError(
        'transport_error',
        `failed to write MCP notification \`${method}\`: ${error instanceof Error ? error.message : String(error)}`,
      ).forServer(this.serverId)
    }
  }

  /**
   * 关闭会话：让在途请求收场 → 关 stdin 请对端自己退 → 等 grace → 还活着就整组强杀。
   *
   * 幂等且**记住结局**：第二次调用返回同一个 Promise，不会对着一个已经收过尸的进程再等一轮
   * grace（disconnect 命令与退出清理都会调到这里，撞上是常态而不是异常）。
   */
  close(graceMs: number): Promise<McpCloseOutcome> {
    this.closePromise ??= this.runClose(graceMs)
    return this.closePromise
  }

  private async runClose(graceMs: number): Promise<McpCloseOutcome> {
    this.closing = true
    this.transportClosed = true
    this.pending.failAll({ kind: 'transport', message: 'MCP server is disconnecting' })
    // 关 stdin 是 MCP stdio 里「请你退出」的规范信号。强杀留给 grace 用尽之后。
    this.writer.close()

    let forcedKill = false
    if (!this.childExited) {
      const timedOut = await this.raceChildExit(graceMs)
      if (timedOut) {
        forcedKill = true
        killChildGroup(this.child)
        await this.whenChildExited()
      }
    }

    this.untrackFromHostExit()
    return { exitCode: this.childExitCode, forcedKill }
  }

  private ensureRunning(): void {
    if (this.closing || this.transportClosed) {
      throw new McpCommandError(
        'transport_closed',
        'MCP server transport is closed',
      ).forServer(this.serverId)
    }
    if (this.childExited) {
      this.transportClosed = true
      throw new McpCommandError(
        'process_exited',
        `MCP server exited before the request (exit code ${formatExitCode(this.childExitCode)})`,
      ).forServer(this.serverId)
    }
    // Rust 还有一个分支：`child` 已被 `take()` 走 → "MCP server process has already been
    // cleaned up"。那对应 close 之后再发请求，而这里那种情况已经被上面的 closing 判掉了，
    // 复现不出来。少一条不可达分支不是漏移植。
  }

  /** 等答案或等到点。到点时**撤销登记**——留着会让迟到的答案投递给一个已经没人听的回调。 */
  private async awaitReply(
    id: number,
    reply: Promise<RpcReply>,
    timeoutMs: number,
  ): Promise<RpcReply | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    })
    try {
      const settled = await Promise.race([reply, deadline])
      if (settled === TIMED_OUT) this.pending.remove(id)
      return settled
    } finally {
      // 定时器必须清：Node 的 event loop 会活到最后一个未触发的定时器为止，留着它，
      // 一次 30ms 就返回的调用会让 CLI 宿主在退出前多挂满整个超时。
      clearTimeout(timer)
    }
  }

  /** 等进程退出，返回是否**到点了**（true = 还没死）。 */
  private raceChildExit(graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.child.removeListener('exit', onExit)
        resolve(true)
      }, graceMs)
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(false)
      }
      this.child.once('exit', onExit)
    })
  }

  private whenChildExited(): Promise<void> {
    if (this.childExited) return Promise.resolve()
    return new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
  }

  /**
   * 子进程退出。等价 Rust 的 `watch_child_process`——那边是 10ms 一轮的 `try_wait()` 轮询，
   * 这边是一个事件，同一件事。
   *
   * 这是**四条清理路径里最容易被忘掉的一条**：子进程自己崩了（或被外面 kill 了）时，没有人
   * 会来调 disconnect，而在途请求正等着一个永远不会到的答案。
   */
  private handleChildExit(code: number | null): void {
    // 两条入口（'exit' 事件、构造时的补偿），只算一次。
    if (this.childExited) return
    this.childExited = true
    this.childExitCode = code
    // 主动关闭时什么都不做：结局由 runClose 自己算，事件也该闭嘴（Rust 的 watcher 同样
    // 在 `closing` 时直接 return）。
    if (this.closing) return
    this.closeTransport(`MCP server process exited (exit code ${formatExitCode(code)})`, true)
    this.untrackFromHostExit()
  }
}

const TIMED_OUT = Symbol('mcp-request-timed-out')
