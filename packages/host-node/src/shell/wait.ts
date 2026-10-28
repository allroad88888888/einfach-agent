// 等待子进程退出：静默超时 + 总时长兜底，终止统一走进程组（Unix）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_wait.rs（已随 T1 删除）。Rust 那边是 10ms 一轮的 `try_wait()`
// 轮询，Node 这边直接等 `'exit'` 事件——同一件事的两种写法，没有轮询间隔可移植。
//
// 【超时判据从「总时长」改成「静默时长」】
// 原实现是 `raceDeadline(exit, timeoutMs)`：一个定时器，到点就杀。它无法区分「跑了两分钟、
// 一直在吐进度」和「沉默两分钟、一个字都没有」——前者是长任务（本仓全量测试 6869 个用例，
// 在本机约 108–120s）的常态，后者也可能仍在工作。一个 120s 的墙钟硬顶因此会把正常的长任务
// 一起收走，表现为 `SHELL_TIMEOUT`，而命令其实一直在正常输出。
//
// 现在两个定时器分工：
//   · idle  —— 每次收到输出就 `refresh()`。连续这么久没有任何输出则触发静默超时。
//   · total —— 不随输出重置的兜底。没有它，一条永远在吐输出的命令（`yes`、滚动的日志）
//               会把调用方永久占住，而那种命令是跑不完的，不是跑得慢。
//
// 【为什么 idle 用 `Timeout.refresh()` 而不是自己记时间戳】见 activity.ts 文件头。
//
// 【超时那一刻进程恰好已经退出】两个定时器都可能与 `'exit'` 抢在同一轮事件循环里。判据仍是
// 原来那条：kill 失败（进程组已不存在）+ 进程确实退出了 → 按「正常退出」报，不标 timed_out。
// 而 kill 成功时不再复查——`process.kill` 是「发出信号」不是「问还在不在」，复查只会在竞态
// 窗口里给出不可靠答案（这条与 taskProcess.ts 的取舍一致）。

import type { ChildProcess } from 'node:child_process'
import type { ActivityPulse } from './activity'

/** 一次等待的结局。`exitCode` 为 null 表示进程被信号杀死（对齐 Rust 的 `ExitStatus::code() == None`）。 */
export interface ChildExit {
  exitCode: number | null
  timedOut: boolean
  /**
   * 超时原因，未超时时为 undefined。
   *
   *   · `idle`  —— 连续 `idleMs` 没有任何输出。
   *   · `total` —— 撞上总时长兜底。
   *
   * 两者对调用方的处置完全不同，所以不能塌成同一个 `timedOut: true`。
   */
  timeoutReason?: 'idle' | 'total'
}

/** 一次等待的两个上限。**互不放宽**：total 到点就杀，不管 idle 还有多少余量。 */
export interface WaitLimits {
  /** 允许的最长静默时长。每收到一块输出就重新计时。 */
  readonly idleMs: number
  /** 总时长兜底，不随输出重置。 */
  readonly totalMs: number
  /** 输出活性脉冲。`captureOutput` 往里发，本函数订阅。 */
  readonly pulse: ActivityPulse
  readonly signal?: AbortSignal
}

/**
 * 等子进程退出；静默超过 `idleMs` 或总时长超过 `totalMs` 就杀掉它。
 *
 * 与 Rust 逐条对齐的两个边角：
 *   · 超时那一刻进程恰好已经退出 → kill 失败（进程组已不存在），此时按「正常退出」报，
 *     不标 timed_out。Rust 走的是 `kill_child` 出错后再 `try_wait` 的那条分支。
 *   · kill 失败且进程确实还活着 → 整条命令以错误告终（桥调用失败），不是一次退出码为 1
 *     的结果。这种情况只在权限异常时出现，静默当成「命令跑完了」会让调用方以为进程没了。
 */
export async function waitForChild(child: ChildProcess, limits: WaitLimits): Promise<ChildExit> {
  const settledExit = exitCodeOf(child)
  // 事件监听挂上之前进程就退出了：ChildProcess 的 exitCode/signalCode 已经写好，直接用。
  if (settledExit !== undefined) return { exitCode: settledExit, timedOut: false }

  let exited = false
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exited = true
      resolve(code)
    })
  })

  let fireTimeout = (_reason: 'idle' | 'total'): void => {}
  const timeoutSignal = new Promise<'idle' | 'total'>((resolve) => {
    fireTimeout = resolve
  })

  // 决出胜负之后就不该再 refresh 了：`Timeout.refresh()` 会重新激活一个**已经触发**的定时器，
  // 而那时 race 早已 settle，重新激活只让定时器无意义地多活一轮。
  let decided = false
  // idle 先注册：两个上限取同一个毫秒数时，先注册的先触发，于是报 `idle`（更具体的那一侧）。
  const idleTimer = setTimeout(() => {
    decided = true
    fireTimeout('idle')
  }, limits.idleMs)
  const totalTimer = setTimeout(() => {
    decided = true
    fireTimeout('total')
  }, limits.totalMs)

  let abort = (): void => {}
  const abortSignal = new Promise<'abort'>((resolve) => { abort = () => resolve('abort') })
  limits.signal?.addEventListener('abort', abort, { once: true })
  if (limits.signal?.aborted) abort()

  const stopListening = limits.pulse.listen(() => {
    if (!decided) idleTimer.refresh()
  })

  try {
    const winner = await Promise.race([exit.then(() => 'exit' as const), timeoutSignal, abortSignal])
    if (winner === 'exit') return { exitCode: await exit, timedOut: false }

    // 已经决定要杀了：先停订阅。否则从这一刻到进程真正死掉之间，它吐的每一行都还在
    // 刷新一个已经有结论的定时器。
    stopListening()

    if (!killChild(child)) {
      if (exited) return { exitCode: await exit, timedOut: false }
      throw new Error('failed to kill timed out child process')
    }
    const exitCode = await exit
    if (winner === 'abort') throw limits.signal?.reason ?? new DOMException('Aborted', 'AbortError')
    return { exitCode, timedOut: true, timeoutReason: winner }
  } finally {
    decided = true
    // `stopListening` 幂等，正常路径里它已经调过一次，这里兜住抛异常那条路径——
    // 漏掉它就等于让一个死掉的等待继续挂在脉冲上。
    stopListening()
    limits.signal?.removeEventListener('abort', abort)
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}

/**
 * 杀进程。Unix 上先杀**整个进程组**（`kill(-pid)`），覆盖 `cmd &` 派生出来的后台进程；
 * 进程组不在了（子进程已退出且组里没有别的成员）就回落到杀直接子进程。
 *
 * 返回是否送出了信号——对齐 Rust `kill_child` 的 `io::Result`，调用方据此决定是报错还是忽略。
 *
 * pid 复用不是隐患：只要进程组里还有活着的成员，这个 pgid 就不会被分配给别的进程。
 * 组空了则 `kill(-pid)` 直接失败（ESRCH），伤不到无关进程。
 */
export function killChild(child: ChildProcess): boolean {
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

/** 已经退出过的子进程的退出码；还活着则 undefined。被信号杀死时是 null。 */
function exitCodeOf(child: ChildProcess): number | null | undefined {
  if (child.exitCode !== null) return child.exitCode
  if (child.signalCode !== null) return null
  return undefined
}
