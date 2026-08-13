//! MCP 子进程的存活监视、强制终止与 stderr 尾部收集。

use std::{
    collections::VecDeque,
    io::{self, Read},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use super::lifecycle::McpLifecycleNotifier;
use super::limits::CHILD_WAIT_POLL_MS;
use super::protocol::{fail_pending, RpcReply};
use super::support::{lock_recover, PendingRequests, SharedStderrTail, SharedWriter};

pub(super) fn watch_child_process(
    child: Arc<Mutex<Option<Child>>>,
    writer: SharedWriter,
    pending: PendingRequests,
    transport_closed: Arc<AtomicBool>,
    lifecycle: McpLifecycleNotifier,
) {
    loop {
        if lifecycle.closing.load(Ordering::Acquire) {
            return;
        }

        let status = {
            let mut child = lock_recover(&child);
            match child.as_mut() {
                Some(child) => child.try_wait(),
                None => return,
            }
        };

        let message = match status {
            Ok(Some(status)) => {
                format!("MCP server process exited (exit code {:?})", status.code())
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(CHILD_WAIT_POLL_MS));
                continue;
            }
            Err(error) => format!("failed to inspect MCP server process: {error}"),
        };

        transport_closed.store(true, Ordering::Release);
        drop(lock_recover(&writer).take());
        fail_pending(&pending, RpcReply::Transport(message.clone()));
        lifecycle.closed(message);
        return;
    }
}

pub(super) fn drain_stderr<R: Read>(mut stderr: R, tail: SharedStderrTail) {
    let mut buffer = [0u8; 4_096];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => lock_recover(&tail).push(&buffer[..read]),
            Err(error) => {
                lock_recover(&tail)
                    .push(format!("\n[failed to read MCP stderr: {error}]\n").as_bytes());
                break;
            }
        }
    }
}

pub(super) struct TailBuffer {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl TailBuffer {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if self.bytes.len() == self.capacity {
                self.bytes.pop_front();
            }
            self.bytes.push_back(*byte);
        }
    }
}

pub(super) fn join_thread(
    handle: &Mutex<Option<JoinHandle<()>>>,
    label: &str,
    stderr_tail: &SharedStderrTail,
) {
    if let Some(handle) = lock_recover(handle).take() {
        if handle.join().is_err() {
            lock_recover(stderr_tail)
                .push(format!("\n[MCP {label} thread terminated unexpectedly]\n").as_bytes());
        }
    }
}

pub(super) fn terminate_spawned_child(child: &mut Child) {
    let _ = kill_child(child);
    let _ = child.wait();
}

#[cfg(unix)]
pub(super) fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
pub(super) fn configure_child_process(_command: &mut Command) {}

#[cfg(unix)]
pub(super) fn kill_child(child: &mut Child) -> io::Result<()> {
    kill_process_group(child.id()).or_else(|_| child.kill())
}

#[cfg(not(unix))]
pub(super) fn kill_child(child: &mut Child) -> io::Result<()> {
    child.kill()
}

#[cfg(unix)]
fn kill_process_group(pid: u32) -> io::Result<()> {
    use std::os::raw::c_int;

    const SIGKILL: c_int = 9;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    let pid = c_int::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "child pid is too large"))?;
    // The child is placed in its own process group at spawn, so a negative PID
    // terminates helper processes spawned by an MCP server as well.
    let result = unsafe { kill(-pid, SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
