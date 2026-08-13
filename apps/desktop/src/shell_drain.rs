//! 直接子进程退出后，回收（或放弃）仍被后台孙进程握着的 stdout/stderr 读线程。

use super::types::{ReaderHandle, ORPHAN_DRAIN_GRACE_MS, ORPHAN_KILL_GRACE_MS, WAIT_POLL_INTERVAL_MS};
use super::wait::kill_child;
use std::{
    io,
    process::Child,
    thread,
    time::{Duration, Instant},
};

/// 直接子进程已经退出，但 stdout/stderr 的写端可能还被它派生的后台孙进程持有
/// （`cmd &`、nohup 之类）。这种情况下读线程永远等不到 EOF —— 超时只覆盖
/// `wait_for_child`，覆盖不到这里，无条件 join 会让整个调用永久挂起。
///
/// 所以先留一小段时间读完残留输出；读不完就说明确实有孤儿握着管道，杀掉整个进程组
/// 逼出 EOF；仍读不完则放弃读线程，用共享缓冲里已捕获的部分输出返回。
///
/// 返回是否清理过后台进程。正常退出且已收到 EOF 的命令不会走到 kill 分支，
/// 真正 daemon 化（关掉继承 fd）的进程同样不受影响。
pub(super) fn drain_output_readers(child: &mut Child, readers: Vec<ReaderHandle>) -> Result<bool, String> {
    let pending = wait_for_readers(readers, Duration::from_millis(ORPHAN_DRAIN_GRACE_MS))?;
    if pending.is_empty() {
        return Ok(false);
    }

    let _ = kill_child(child);
    let _ = child.try_wait();
    let _ = wait_for_readers(pending, Duration::from_millis(ORPHAN_KILL_GRACE_MS))?;
    Ok(true)
}

/// 在 deadline 内轮询回收已结束的读线程，返回仍未结束的那些（不 join，避免阻塞）。
fn wait_for_readers(
    readers: Vec<ReaderHandle>,
    timeout: Duration,
) -> Result<Vec<ReaderHandle>, String> {
    let start = Instant::now();
    let mut pending = readers;

    loop {
        let mut still_reading = Vec::with_capacity(pending.len());
        for (handle, stream_name) in pending {
            if handle.is_finished() {
                join_output_reader(handle, stream_name)?;
            } else {
                still_reading.push((handle, stream_name));
            }
        }
        pending = still_reading;

        if pending.is_empty() || start.elapsed() >= timeout {
            return Ok(pending);
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS));
    }
}

fn join_output_reader(
    handle: thread::JoinHandle<io::Result<()>>,
    stream_name: &str,
) -> Result<(), String> {
    handle
        .join()
        .map_err(|_| format!("{stream_name} reader thread panicked"))?
        .map_err(|err| format!("failed to read child {stream_name}: {err}"))
}
