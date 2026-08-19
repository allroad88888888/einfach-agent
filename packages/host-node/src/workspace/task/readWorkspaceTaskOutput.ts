// 并发读子进程的 stdout 与 stderr——两路都是 drain 语义
// ---------------------------------------------------------------------------
// 等价移植 Rust 侧 `run_workspace_task_blocking` 的这两行（逐字核对过
// apps/desktop/src/workspace_task.rs（已随 T1 删除）：文件顶部只 `use` 了 `read_capped_drain`，压根没有 import
// `read_capped_stop`）：
//   let stdout_handle = thread::spawn(move || read_capped_drain(stdout, max_output_chars));
//   let stderr_handle = thread::spawn(move || read_capped_drain(stderr, max_output_chars));
//
// 这与 workspace_git_exec.rs / workspace_rg.rs 里「stdout 用 stop、stderr 用 drain」的搭配**不
// 一样**——那两处的 stdout 是「读它是为了拿内容，够了就该叫停」（一次 git diff / 一次 rg 搜索，
// 内容超限时调用方本就打算杀掉子进程重来）。预置任务不是这个模式：一次 `pnpm test` 可能在还没
// 写够 max_output_chars 之前就已经打算把全部日志吐完，用 stop 会在到达上限的瞬间不再消费
// stdout，一旦子进程还在疯狂往 stdout 写（测试框架的详细日志常见），管道缓冲区写满后子进程会
// 卡在写系统调用里，永远等不到自然退出，只能靠超时硬杀——那会把「本该在超时前正常完成、只是
// 输出略超上限」的任务错误地报成 `timedOut: true`。两路都排空可以避免这个假超时：截断只发生在
// 保留的文本上，从不影响子进程能不能顺畅退出。
//
// 两路必须**并发**读，且必须在调用方 `await` 等子进程退出**之前**就发起（不 await 本函数）——
// 这条不变量与 stop/drain 的选择无关，是并发读取本身的要求：管道缓冲区有限，谁不读谁堵，
// 堵住的写端会让子进程卡在一次系统调用里，永远等不到退出，也永远等不到超时杀它的那一刻。

import type { Readable } from 'node:stream'
import { readCappedDrain, type CappedRead } from '../common'

export interface WorkspaceTaskOutput {
  stdout: CappedRead
  stderr: CappedRead
}

export function readWorkspaceTaskOutput(
  stdout: Readable,
  stderr: Readable,
  maxOutputChars: number,
): Promise<WorkspaceTaskOutput> {
  const stdoutPromise = readCappedDrain(stdout, maxOutputChars)
  const stderrPromise = readCappedDrain(stderr, maxOutputChars)
  return Promise.all([stdoutPromise, stderrPromise]).then(([stdoutResult, stderrResult]) => ({
    stdout: stdoutResult,
    stderr: stderrResult,
  }))
}
