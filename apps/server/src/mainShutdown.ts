// 停服信号 → 关停钩子 → 退出：让 `SIGTERM` 不再漏下 MCP 子进程
// ---------------------------------------------------------------------------
// 【要补的缺口】Node 对**没有 listener 的 SIGTERM / SIGINT / SIGHUP 走默认处置直接终止，
// `process.on('exit')` 回调根本不执行**（C1 已用探针实测，本卡在 `mainShutdownSignal.test.ts`
// 里用一条负对照又验了一遍）。而 host-node 的 MCP 子进程被有意放进**自己的进程组**
// （`mcp/childProcess.ts` 的 `detached`），不会跟着父进程一起死——于是 `kill <pid>` 停服会留下
// 一批谁也想不到的常驻进程。host-node 自带的那道 `process.on('exit')` 兜底（`mcp/exitNet.ts`）
// 恰好覆盖不到信号这条路，所以信号必须由宿主装配层自己处理。
//
// 能力包刻意不装信号处理器（理由见 `packages/host-node/src/hostOptions.ts` 的
// `registerHostDisposer` 槽注释），它只交出 `dispose`。本文件就是 server 宿主这一侧的挂载点。
//
// ═══ 三个必须正面回答的问题 ═══
//
// ① **等多久**：默认 2000 ms（`DEFAULT_SHUTDOWN_TIMEOUT_MS`）。下界来自 host-node：一条 MCP 会话
//    的关闭是「关 stdin → 等 grace（`DEFAULT_DISCONNECT_GRACE_MS` = 500 ms）→ 还活着就整组
//    SIGKILL」，而 `disposeAll()` 是**并发**关全部会话，所以正常情况的耗时约等于一个 grace。
//    取 4 倍余量。上界来自两头：容器/服务管理器给的耐心（`docker stop` 默认 10 s，systemd 的
//    `TimeoutStopSec` 默认 90 s）——2 s 稳稳在里面；以及人的耐心——Ctrl+C 之后界面卡住超过两秒
//    就会有人再按一次，而那第二次必须是"立刻退出"（见 ③）。
//
// ② **等不到时的兜底**：超时后照样 `exit(code)`，**而这一步会让 host-node 的
//    `process.on('exit')` 兜底跑起来**——它在那里同步地把每个还活着的子进程整组 SIGKILL。
//    这正是"我们自己调用 exit"与"被信号默认处置终结"的关键差别：前者跑 'exit' 回调，后者不跑。
//    所以本文件的超时**不是**"放弃清理"，只是"放弃优雅清理"，降级成硬杀，一个都不漏。
//    因此退出走 `process.exit(128 + signo)` 而**不是**「摘掉 listener 再把信号原样发给自己」：
//    后者退出状态更贴合 shell 惯例（"被信号杀死"而不是"退出码 143"），但它恰好绕开 'exit' 回调，
//    把兜底一起绕掉了。退出码用 128 + 信号号是 shell 的通用约定（SIGINT→130、SIGTERM→143）。
//
// ③ **重复收到信号**：第二次信号不再等待，当场退出（仍然经 `exit()`，兜底仍然生效）。用户连按
//    两次 Ctrl+C 是常态，第二次的意思就是"别等了"。**不这么做的后果不是"多等一会儿"**：第一次
//    信号已经装了 listener、进程不再默认终止，若第二次也只是排队等同一个 dispose，用户会觉得
//    Ctrl+C 失灵。
//
// 【本文件不 `server.close()`】停服时故意不去优雅关闭 HTTP 连接：`close()` 要等所有在途连接自己
// 断开，而 SSE（C3）那种长连接**永远不会**自己断开，等它等于永远不退出。端口在进程退出时由内核
// 回收，这里没有需要抢救的状态。
//
// 【与 `apps/cli/src/shutdown.ts` 的关系】两个宿主各有一份，**不是遗漏**：CLI 那份的信号语义与
// 文案完全不同（Ctrl+C 在 REPL 里根本到不了进程，见那个文件的文件头），而两个 app 之间没有合法
// 的 import 路径，为 40 行逻辑新开一个 workspace 包要同步改 vite alias 与 tsconfig paths、
// 波及面远大于它省下的重复。若将来出现第三个 Node 宿主，正确的去处是把它做成 host-node 里一个
// **必须显式调用**的 helper（而不是能力包自动装的隐式全局）。

import { constants } from 'node:os'

/**
 * 只接这三个信号，且**只能**是这三个：它们的默认处置都是"终止进程"，所以接管它们不会改变
 * 任何一次退出的可见语义，只是在退出前多做一次清理。SIGHUP 一并接住是因为"关掉终端窗口"
 * 与 Ctrl+C、`kill` 一样常见，而它漏下的子进程一模一样。
 */
export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP'

export const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

/** 见文件头 ①。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000

/**
 * 信号挂载与退出的目标。生产是 `process` 本身，**测试必须传一个假的**——真挂到 `process` 上会
 * 在测试进程里攒 listener（`runServerCli` 在一个测试文件里会被调好几次），而 `exit()` 会把
 * vitest 自己杀掉。
 */
export interface ShutdownSignalTarget {
  on(signal: ShutdownSignal, listener: () => void): unknown
  exit(code: number): void
}

export interface HostShutdownOptions {
  /** 默认 `process`。 */
  readonly target?: ShutdownSignalTarget
  /** 默认 `SHUTDOWN_SIGNALS`。 */
  readonly signals?: readonly ShutdownSignal[]
  /** 默认 `DEFAULT_SHUTDOWN_TIMEOUT_MS`。 */
  readonly timeoutMs?: number
  /** 用户可见提示的去处；默认写 stdout（启动信息也在那条流上）。 */
  readonly notice?: (text: string) => void
}

export interface HostShutdown {
  /**
   * 交给 `createNodeHostInvoke` 的 `registerHostDisposer` 槽。可以被调多次（每个能力包一次），
   * 收到的 dispose 在收到信号时**并发**执行。
   */
  readonly registerHostDisposer: (dispose: () => Promise<void>) => void
}

/** 128 + 信号号，shell 的通用约定。三个信号在任何平台上都有号，不需要兜底分支以外的处理。 */
function exitCodeForSignal(signal: ShutdownSignal): number {
  return 128 + constants.signals[signal]
}

/**
 * 装上信号处理并返回关停钩子的登记面。调用即生效，没有第二步。
 *
 * 刻意**没有**卸载/反注册的返回值：本函数只在进程入口调用一次，给一个"能摘掉"的口子等于
 * 邀请别人在半路把清理摘掉。测试改用注入的假 target，不需要卸载。
 */
export function installHostShutdown(options: HostShutdownOptions = {}): HostShutdown {
  const target = options.target ?? process
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const notice = options.notice ?? ((text: string) => { process.stdout.write(text) })
  const disposers: Array<() => Promise<void>> = []
  let draining = false

  const handleSignal = (signal: ShutdownSignal): void => {
    const code = exitCodeForSignal(signal)
    if (draining) {
      // 第二次信号：不再等待。这一行提示可能来不及刷出去（stdout 接管道时是异步写，
      // 而 exit 不保证 flush），所以它只是锦上添花，判据不建立在它身上。
      notice('再次收到停止信号，不再等待收尾，立即退出。\n')
      target.exit(code)
      return
    }
    draining = true
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
    void Promise.allSettled(disposers.map(async (dispose) => dispose())).then(() => {
      clearTimeout(timer)
      exitOnce()
    })
  }

  for (const signal of options.signals ?? SHUTDOWN_SIGNALS) {
    target.on(signal, () => { handleSignal(signal) })
  }

  return {
    registerHostDisposer: (dispose) => { disposers.push(dispose) },
  }
}
