// 直接子进程退出后，回收（或放弃）仍被后台孙进程握着的 stdout/stderr
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_drain.rs，连注释里的病因一起搬过来：
//
// 直接子进程已经退出，但 stdout/stderr 的写端可能还被它派生的后台孙进程持有
// （`cmd &`、nohup 之类）。这种情况下读端永远等不到 EOF —— 超时只覆盖 `waitForChild`，
// 覆盖不到这里，无条件等下去会让整个调用永久挂起（Rust 侧实测过一次 96 分钟的挂死）。
//
// 所以先留一小段时间读完残留输出；读不完就说明确实有孤儿握着管道，杀掉整个进程组逼出 EOF；
// 仍读不完则放弃读取，用已捕获的部分输出返回。
//
// 返回是否清理过后台进程。正常退出且已收到 EOF 的命令不会走到 kill 分支，
// 真正 daemon 化（关掉继承 fd）的进程同样不受影响。

import type { ChildProcess } from 'node:child_process'
import { raceDeadline } from './deadline'
import type { OutputCapture } from './outputCapture'
import { ORPHAN_DRAIN_GRACE_MS, ORPHAN_KILL_GRACE_MS } from './types'
import { killChild } from './wait'

export async function drainOutputReaders(
  child: ChildProcess,
  captures: readonly OutputCapture[],
): Promise<boolean> {
  const pending = await waitForCaptures(captures, ORPHAN_DRAIN_GRACE_MS)
  if (pending.length === 0) return false

  killChild(child)
  const stillReading = await waitForCaptures(pending, ORPHAN_KILL_GRACE_MS)

  // Rust 到这里是「丢掉 JoinHandle，让线程和它握着的 fd 一起泄漏」。Node 能做得干净些：
  // 主动结束读取并销毁流，已读到的部分照常返回。等一下 done 是因为放弃是异步生效的，
  // 不等就可能在 take() 里拿到上一刻的空文本；abandon 保证它一定 resolve，不会卡住。
  for (const capture of stillReading) capture.abandon()
  await Promise.all(stillReading.map((capture) => capture.done))
  return true
}

/**
 * 在 deadline 内等这些捕获结束，返回仍未结束的那些。
 *
 * 已结束的捕获若带着读错误，就地抛出——对齐 Rust 的 `join_output_reader`：读管道失败是
 * 桥调用失败（`Err`），不是一次 exit_code 为 1 的命令结果。
 */
async function waitForCaptures(
  captures: readonly OutputCapture[],
  timeoutMs: number,
): Promise<OutputCapture[]> {
  await raceDeadline(
    Promise.all(captures.map((capture) => capture.done)),
    timeoutMs,
  )
  for (const capture of captures) {
    if (capture.failure) throw capture.failure
  }
  return captures.filter((capture) => !capture.settled)
}
