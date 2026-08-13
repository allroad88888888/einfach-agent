//! shell 命令执行的结果类型、内部输出结构与超时/输出上限常量。

use serde::Serialize;
use std::{
    io,
    sync::{Arc, Mutex},
    thread,
};

pub(super) const DEFAULT_MAX_OUTPUT_CHARS: usize = 20_000;
pub(super) const MAX_OUTPUT_CHARS: usize = 100_000;
pub(super) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub(super) const MAX_TIMEOUT_MS: u64 = 120_000;
pub(super) const WAIT_POLL_INTERVAL_MS: u64 = 10;
// 直接子进程退出后，残留在管道里的输出只有一个管道缓冲区那么多，读完是微秒级的；
// 留 500ms 是给线程调度的余量，正常命令不会等满（读完即返回）。
pub(super) const ORPHAN_DRAIN_GRACE_MS: u64 = 500;
// 杀掉进程组到写端真正关闭之间同样只需调度余量。
pub(super) const ORPHAN_KILL_GRACE_MS: u64 = 500;

#[derive(Serialize)]
pub struct ShellCommandResult {
    pub(super) platform: String,
    pub(super) shell: String,
    pub(super) command: String,
    pub(super) cwd: String,
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) duration_ms: u64,
    pub(super) timed_out: bool,
    pub(super) truncated: bool,
    /// 命令留下了仍持有 stdout/stderr 的后台进程，它们已被强制清理。
    /// 调用方据此知道 `cmd &` 起的服务并没有活下来。
    pub(super) background_processes_killed: bool,
}

pub(super) struct ShellSpec {
    pub(super) program: &'static str,
    pub(super) args: &'static [&'static str],
    pub(super) display: String,
}

#[derive(Default)]
pub(super) struct CapturedOutput {
    pub(super) text: String,
    pub(super) chars_written: usize,
    pub(super) truncated: bool,
}

/// 读线程与调用线程共享捕获缓冲：读线程可能因孤儿进程握着管道而永不结束，
/// 此时调用线程仍要能取走已经读到的部分输出。
pub(super) type OutputSink = Arc<Mutex<CapturedOutput>>;

pub(super) type ReaderHandle = (thread::JoinHandle<io::Result<()>>, &'static str);
