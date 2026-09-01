// CLI 宿主的关停路径：收到终止信号时先关掉 MCP 子进程，再退出
// ---------------------------------------------------------------------------
// 【要补的缺口】Node 对**没有 listener 的 SIGTERM / SIGINT / SIGHUP 走默认处置直接终止，
// `process.on('exit')` 回调根本不执行**。而 host-node 的 MCP 子进程被有意放进自己的进程组
// （`mcp/childProcess.ts` 的 `detached`），不会跟着父进程一起死——它自带的那道
// `process.on('exit')` 兜底（`mcp/exitNet.ts`）恰好覆盖不到信号这条路。能力包刻意不自己装信号
// 处理器（理由见 `packages/host-node/src/hostOptions.ts` 的 `registerHostDisposer` 槽），
// 于是这件事必须由宿主装配层做，本文件就是 CLI 这一侧。
//
// ═══ 为什么接 SIGINT 不会改掉 REPL 的 Ctrl+C 语义（实测，不是推测）═══
// 这是本文件唯一需要小心的地方。**REPL 里的 Ctrl+C 根本到不了进程**：readline 在 TTY 上把
// stdin 切进 raw mode，终端驱动的 ISIG 因此关掉，`^C` 只是一个 0x03 字节；readline 读到它、
// 发现自己没有 'SIGINT' 监听者，于是 `close()` 掉这个 interface。进程从头到尾收不到 SIGINT，
// 装不装 listener 都一样。
//
// 用 pty 驱动真进程实测过（macOS / Node v24），两种时机结论一致：
//   · 在提示符处按 Ctrl+C   → interface 'close'，等待中的 `question()` 以 `ABORT_ERR` reject；
//   · 在一轮跑到一半时按    → 同样只是 interface 'close'，**本轮照常跑完**，下一次
//                             `question()` 抛 `ERR_USE_AFTER_CLOSE`。
//   两种情况下，进程级的 SIGINT 处理器**一次都没有被调用**。
// 也就是说今天 CLI 的 Ctrl+C 既不是"中断本轮"也不是干净的"退出"，而是"关掉输入通道，
// 于是 REPL 在本轮结束后带着一条错误收场"。**那是既有行为，本文件不碰它**——要把它做成
// 真正的"中断本轮"（给 interface 装 'SIGINT' 监听、abort 当前 run）是另一张卡的事。
//
// 剩下那些**进程真的会收到信号**的场合，本来就一律是"进程要死了"：
//   · `-p` 一次性模式（没有 readline，Ctrl+C 直达进程）；
//   · stdin 不是 TTY（管道喂输入，readline 不进 raw mode）；
//   · `kill` / `kill -INT` / 关掉终端窗口（SIGHUP）；
//   · 服务管理器或父进程停掉它（SIGTERM）。
// 这些场合原先的结局是"立即死、留下 MCP 子进程"，现在是"先收尾再死"。可见语义不变。
//
// ═══ 等多久 / 等不到怎么办 / 连按两次怎么办 ═══
// ① **等多久**：默认 2000 ms。一条 MCP 会话的关闭是「关 stdin → 等 grace
//    （host-node 的 `DEFAULT_DISCONNECT_GRACE_MS` = 500 ms）→ 还活着就整组 SIGKILL」，
//    而 `disposeAll()` 并发关全部会话，正常耗时约等于一个 grace，取 4 倍余量。
// ② **等不到**：超时照样退出，**而退出这一步会让 host-node 的 `process.on('exit')` 兜底跑起来**
//    ——它同步地把每个还活着的子进程整组 SIGKILL。所以退出必须走 `process.exit(128 + 信号号)`，
//    **不能**"摘掉 listener 再把信号发给自己"：那样退出状态更贴合 shell 惯例，却恰好绕开 'exit'
//    回调，把兜底一起绕掉。超时不是"放弃清理"，是"降级成硬杀"。
// ③ **连按两次**：第二次信号不再等待，当场退出（仍走 `exit()`，兜底仍生效）。
//
// 【与 `apps/server/src/mainShutdown.ts` 的关系】两个宿主各一份，不是遗漏：语义与文案不同
// （server 的 Ctrl+C 就是"停服"，启动信息里已经这么写了；CLI 是上面这一长串），而两个 app 之间
// 没有合法的 import 路径，为 40 行逻辑新开一个 workspace 包要同步改 vite alias 与 tsconfig
// paths，波及面远大于省下的重复。出现第三个 Node 宿主时，正确的去处是把它做成 host-node 里一个
// **必须显式调用**的 helper（而不是能力包自动装的隐式全局）。

import { constants } from 'node:os'

/**
 * 只接这三个信号，且**只能**是这三个：它们的默认处置都是"终止进程"，接管它们不改变任何一次
 * 退出的可见语义，只是在退出前多做一次清理。
 */
export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP'

export const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

/** 见文件头 ①。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000

/**
 * 信号挂载与退出的目标。生产是 `process` 本身，**测试必须传假的**——真挂上去会在测试进程里
 * 攒 listener，而 `exit()` 会把 vitest 自己杀掉。
 */
export interface ShutdownSignalTarget {
  on(signal: ShutdownSignal, listener: () => void): unknown
  exit(code: number): void
}

export interface CliShutdownOptions {
  /** 默认 `process`。 */
  readonly target?: ShutdownSignalTarget
  /** 默认 `SHUTDOWN_SIGNALS`。 */
  readonly signals?: readonly ShutdownSignal[]
  /** 默认 `DEFAULT_SHUTDOWN_TIMEOUT_MS`。 */
  readonly timeoutMs?: number
  /**
   * 用户可见提示的去处；默认写 **stderr**。不写 stdout 是刻意的：`-p` 模式下 stdout 是这次运行
   * 的结果，可能正被另一个程序读，收尾提示不该混进去。
   */
  readonly notice?: (text: string) => void
}

export interface CliShutdown {
  /**
   * 交给 `createNodeHostInvoke` 的 `registerHostDisposer` 槽。可被调多次，收到的 dispose 在
   * 信号到来时**并发**执行。
   */
  readonly registerHostDisposer: (dispose: () => Promise<void>) => void
  /** Drains every registered disposer once; normal completion and signal shutdown share it. */
  readonly drain: () => Promise<void>
}

/** 128 + 信号号，shell 的通用约定（SIGINT→130、SIGTERM→143、SIGHUP→129）。 */
function exitCodeForSignal(signal: ShutdownSignal): number {
  return 128 + constants.signals[signal]
}

/**
 * 装上信号处理并返回关停钩子的登记面。调用即生效，没有第二步，也**不返回卸载函数**——
 * 它只在进程入口调用一次，给一个"能摘掉"的口子等于邀请别人在半路把清理摘掉。
 */
export function installCliShutdown(options: CliShutdownOptions = {}): CliShutdown {
  const target = options.target ?? process
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const notice = options.notice ?? ((text: string) => { process.stderr.write(text) })
  const disposers: Array<() => Promise<void>> = []
  let draining = false
  let signalDraining = false
  let drainPromise: Promise<void> | undefined

  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise
    draining = true
    drainPromise = Promise.allSettled(disposers.map(async (dispose) => dispose())).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'CLI shutdown disposers failed')
    })
    return drainPromise
  }

  const handleSignal = (signal: ShutdownSignal): void => {
    const code = exitCodeForSignal(signal)
    if (signalDraining) {
      // 这一行可能来不及刷出去（stderr 接管道时是异步写，exit 不保证 flush），
      // 所以它只是锦上添花，判据不建立在它身上。
      notice('再次收到停止信号，不再等待收尾，立即退出。\n')
      target.exit(code)
      return
    }
    signalDraining = true
    notice(`正在停止（收到 ${signal}）……最多等待 ${timeoutMs} 毫秒收尾。\n`)

    let exited = false
    const exitOnce = (): void => {
      if (exited) return
      exited = true
      target.exit(code)
    }
    // 超时也照样退出，交给 host-node 的 'exit' 兜底整组硬杀（文件头 ②）。
    // `unref` 是为了假 target 的用例：那时没人真的退出，一个 ref 住的定时器会把 event loop
    // 多钉住 timeoutMs。
    const timer = setTimeout(exitOnce, timeoutMs)
    timer.unref()

    // `allSettled`：某个 dispose 抛了不能拖住其余的，更不能变成未捕获 rejection——
    // Node v15 起未处理的 rejection 默认结束进程，那会在清理做完之前把进程掀翻。
    void drain().then(
      () => { clearTimeout(timer); exitOnce() },
      () => { clearTimeout(timer); exitOnce() },
    )
  }

  for (const signal of options.signals ?? SHUTDOWN_SIGNALS) {
    target.on(signal, () => { handleSignal(signal) })
  }

  return {
    registerHostDisposer: (dispose) => {
      if (draining) throw new Error('CLI shutdown is already draining; cannot register a disposer')
      disposers.push(dispose)
    },
    drain,
  }
}
