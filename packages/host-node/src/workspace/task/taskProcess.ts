// 起子进程、带超时地等它退出、杀超时进程
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs（已随 T1 删除）的 `spawn_task` / `wait_for_child` / `kill_child`
// / `kill_process_group`。stdout/stderr 的**读**不在本文件——那是 readWorkspaceTaskOutput.ts
// 的事，本文件只管进程生命周期。
//
// 等待采用 Node exit 事件。timeoutMs 现在表示输出静默窗口，两路输出都会刷新它；
// 总执行时长由独立的 1800 秒定时器限制。此处仅观察输出，文本捕获仍由输出读取器负责。
//
// 【与 Rust 的另一处刻意简化】
// Rust 的超时分支区分「kill 失败但发现进程其实已经自己退出（判定为**未超时**，取当时的退出码）」
// 与「kill 失败且进程仍在跑（真错误）」。这个区分依赖同步、可重复调用的 `try_wait`。Node 的
// `child.kill()` 不是「问一下还在不在跑」，而是「发个信号」，两者语义不对等，勉强用
// `child.exitCode`/`child.signalCode` 猜测「是不是已经退出」在竞态窗口内并不可靠。
// 本实现改为：`exit` 事件一旦先于超时定时器触发，`clearTimeout` 会让超时回调根本不会执行
// （见 settle()），所以「进程在超时那一刻恰好自然退出」这条路径本来就走不到 kill 分支——
// 唯一会调用 kill 的场景就是进程确实还在跑，因此不需要再补一次「误杀已退出进程」的判定。
// 只有当 kill 本身彻底失败（两种杀法都不成功）且进程明确仍未退出时，才判定为硬错误。

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { errorText } from '../common'
import type { TaskSpec } from './resolveTask'

const isUnix = process.platform !== 'win32'

/**
 * 起子进程，等到它真正 spawn 成功（或失败）才 resolve/reject——对齐 Rust `Command::spawn()`
 * 的同步失败语义。Node 的 `spawn()` 调用本身不抛：ENOENT 之类的失败要等 `'error'` 事件才知道，
 * 所以这里用一个 Promise 把「等 spawn 结果」显式做出来，而不是把 ChildProcess 直接扔给调用方
 * 自己猜有没有起来。
 *
 * stdin 恒为 `Stdio::null()`（对齐 Rust：任务不该等交互输入）；`detached: isUnix` 让子进程
 * 自成一个新的进程组（等价 Rust 的 `process_group(0)`），超时杀进程时才能连它派生的孙进程
 * 一起收，不留下漏网的僵尸构建/测试进程。
 */
export function spawnTask(task: TaskSpec, cwd: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(task.program, task.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isUnix,
    })
    child.once('error', (error) => {
      reject(new Error(`failed to spawn \`${task.program}\`: ${errorText(error)}`))
    })
    child.once('spawn', () => resolve(child))
  })
}

export interface WaitForChildResult {
  exitCode: number
  timedOut: boolean
  timeoutReason?: 'idle' | 'total'
}

/** 静默窗口由两路原始输出刷新；总时长固定兜底。保留 task 自己的进程组终止契约。 */
export function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  totalMs = 1_800_000,
): Promise<WaitForChildResult> {
  if ((child.exitCode !== null || child.signalCode !== null)
    && (!child.stdout || child.stdout.closed) && (!child.stderr || child.stderr.closed)) {
    return Promise.resolve({ exitCode: child.exitCode ?? 1, timedOut: false })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timeoutReason: 'idle' | 'total' | undefined

    function cleanup(): void {
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      child.stdout?.off('data', touch)
      child.stderr?.off('data', touch)
      child.off('close', onClose)
      child.off('error', onError)
    }

    function onClose(code: number | null): void {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        exitCode: code ?? (timeoutReason ? -1 : 1),
        timedOut: timeoutReason !== undefined,
        ...(timeoutReason ? { timeoutReason } : {}),
      })
    }

    function onError(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(new Error(`failed to poll task process: ${errorText(error)}`))
    }

    function expire(reason: 'idle' | 'total'): void {
      if (settled || timeoutReason) return
      timeoutReason = reason
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      try {
        const killed = killProcessGroup(child) || child.kill('SIGKILL')
        if (!killed) {
          onError(new Error('failed to kill timed out task process: process refused SIGKILL'))
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(errorText(error)))
      }
      // 等 close 收齐进程状态与管道 EOF，不在发送信号后提前 resolve。
    }

    function touch(chunk: Buffer | string): void {
      if (!settled && !timeoutReason && chunk.length > 0) idleTimer.refresh()
    }

    const idleTimer = setTimeout(() => expire('idle'), timeoutMs)
    const totalTimer = setTimeout(() => expire('total'), totalMs)
    // exit 仅表示直接子进程退出；close 才表示继承管道的后代也已释放输出。
    // 直到 close 都保留双超时，否则父进程先退出会让输出 drain 永久悬挂。
    child.once('close', onClose)
    child.once('error', onError)
    // 监听的是截断之前的数据：即使保留文本已满，活性仍持续刷新。
    child.stdout?.on('data', touch)
    child.stderr?.on('data', touch)
  })
}

/** 杀整个进程组（对齐 Rust `kill(-pid, SIGKILL)`）。仅 Unix；失败返回 false 交调用方降级。 */
function killProcessGroup(child: ChildProcess): boolean {
  if (!isUnix || typeof child.pid !== 'number') return false
  try {
    process.kill(-child.pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
