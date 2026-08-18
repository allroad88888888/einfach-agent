// 起子进程、带超时地等它退出、杀超时进程
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs 的 `spawn_task` / `wait_for_child` / `kill_child`
// / `kill_process_group`。stdout/stderr 的**读**不在本文件——那是 readWorkspaceTaskOutput.ts
// 的事，本文件只管进程生命周期。
//
// 【与 Rust 的一处刻意不同：等待机制】
// Rust 用一个 10ms 轮询循环（`try_wait` + `thread::sleep`）自己实现「等到超时或退出」。
// Node 没有同步、非阻塞的 waitpid 可用，但有对应的事件——子进程的 `exit` 事件——所以这里改用
// `setTimeout` 竞速 `child.once('exit', ...)`，语义等价（谁先到算谁），且不占一个轮询线程。
// 这不是抄近道，是 Node 侧更自然的表达同一件事的方式。
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
}

/**
 * 等子进程退出，超过 `timeoutMs` 就杀掉它（连同它的进程组）并把结果标成 `timedOut: true`。
 *
 * 退出码规则对齐 Rust 的 `status.code().unwrap_or(...)`：正常退出但拿不到 code（被信号杀死）时，
 * 未超时用 `1`，超时（我们主动 SIGKILL 的）用 `-1`——同一个「拿不到 code」，含义按是谁杀的来分。
 */
export function waitForChild(child: ChildProcess, timeoutMs: number): Promise<WaitForChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false

    function settle(result: WaitForChildResult): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    function fail(message: string): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(message))
    }

    const timer = setTimeout(() => {
      timedOut = true
      const killed = killProcessGroup(child) || child.kill('SIGKILL')
      if (!killed && child.exitCode === null && child.signalCode === null) {
        fail('failed to kill timed out task process: process refused SIGKILL')
      }
      // 杀成功（或已经在退出路上）时不在这里 resolve——交给下面的 'exit' 监听器收尾，
      // 等价 Rust 杀成功后阻塞 `child.wait()` 拿真实退出状态。
    }, timeoutMs)

    child.once('exit', (code) => {
      settle({ exitCode: code ?? (timedOut ? -1 : 1), timedOut })
    })

    child.once('error', (error) => {
      fail(`failed to poll task process: ${errorText(error)}`)
    })
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
