// 等待子进程退出，超时则终止；终止统一走进程组（Unix），好覆盖它派生的后台进程
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_wait.rs（已随 T1 删除）。Rust 那边是 10ms 一轮的 `try_wait()` 轮询，
// Node 这边直接等 `'exit'` 事件——同一件事的两种写法，没有轮询间隔可移植。

import type { ChildProcess } from 'node:child_process'
import { raceDeadline } from './deadline'

/** 一次等待的结局。`exitCode` 为 null 表示进程被信号杀死（对齐 Rust 的 `ExitStatus::code() == None`）。 */
export interface ChildExit {
  exitCode: number | null
  timedOut: boolean
}

/**
 * 等子进程退出，超过 `timeoutMs` 就杀掉它。
 *
 * 与 Rust 逐条对齐的两个边角：
 *   · 超时那一刻进程恰好已经退出 → kill 失败（进程组已不存在），此时按「正常退出」报，
 *     不标 timed_out。Rust 走的是 `kill_child` 出错后再 `try_wait` 的那条分支。
 *   · kill 失败且进程确实还活着 → 整条命令以错误告终（桥调用失败），不是一次退出码为 1
 *     的结果。这种情况只在权限异常时出现，静默当成「命令跑完了」会让调用方以为进程没了。
 */
export async function waitForChild(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  const settled = exitCodeOf(child)
  // 事件监听挂上之前进程就退出了：ChildProcess 的 exitCode/signalCode 已经写好，直接用。
  if (settled !== undefined) return { exitCode: settled, timedOut: false }

  let exited = false
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exited = true
      resolve(code)
    })
  })

  const timedOut = await raceDeadline(exit, timeoutMs)
  if (!timedOut) return { exitCode: await exit, timedOut: false }

  if (!killChild(child)) {
    if (exited) return { exitCode: await exit, timedOut: false }
    throw new Error('failed to kill timed out child process')
  }
  return { exitCode: await exit, timedOut: true }
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
