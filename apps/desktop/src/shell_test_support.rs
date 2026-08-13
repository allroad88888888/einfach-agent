//! shell 测试共用的临时目录与宿主平台字符串构造。

use super::platform::current_platform;
use std::{
    env, fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

// 每个用例独立的临时目录：进程 pid + 原子计数器拼唯一子目录，避免并发撞目录；
// canonicalize 后与子进程 `pwd` 打印的物理路径一致（macOS 上 /var -> /private/var）。
pub(super) fn unique_dir() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut dir = env::temp_dir();
    dir.push(format!("shell_it_{}_{}", std::process::id(), seq));
    fs::create_dir_all(&dir).expect("create temp dir");
    fs::canonicalize(&dir).expect("canonicalize temp dir")
}

// 当前宿主平台字符串——run_shell_command_blocking 要求 requested==current，
// 否则直接返回 platform mismatch 的 failed_result（跑不到真实 spawn）。
pub(super) fn host_platform() -> String {
    current_platform().to_string()
}
