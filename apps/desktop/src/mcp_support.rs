//! MCP stdio 子模块共享的句柄别名与锁 / 时长小助手。

use std::{
    collections::HashMap,
    process::ChildStdin,
    sync::{mpsc, Arc, Mutex, MutexGuard},
    time::Duration,
};

use super::process::TailBuffer;
use super::protocol::RpcReply;

pub(super) type SharedWriter = Arc<Mutex<Option<ChildStdin>>>;
pub(super) type PendingRequests = Arc<Mutex<HashMap<u64, mpsc::SyncSender<RpcReply>>>>;
pub(super) type SharedStderrTail = Arc<Mutex<TailBuffer>>;

pub(super) fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

pub(super) fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
