//! 等待子进程退出，超时则终止；进程终止统一走进程组 kill（Unix）以覆盖直接子进程派生的后台进程。

use super::types::WAIT_POLL_INTERVAL_MS;
use std::{
    io,
    process::Child,
    thread,
    time::{Duration, Instant},
};

pub(super) fn wait_for_child(child: &mut Child, timeout_ms: u64) -> Result<(Option<i32>, bool), String> {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll child process: {err}"))?
        {
            return Ok((status.code(), false));
        }

        if start.elapsed() >= timeout {
            if let Err(kill_err) = kill_child(child) {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|err| format!("failed to poll child process after timeout: {err}"))?
                {
                    return Ok((status.code(), false));
                }

                return Err(format!(
                    "failed to kill timed out child process: {kill_err}"
                ));
            }

            let status = child
                .wait()
                .map_err(|err| format!("failed to wait for timed out child process: {err}"))?;
            return Ok((status.code(), true));
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS));
    }
}

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
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }

    let pid = c_int::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "child pid does not fit c_int"))?;
    let result = unsafe { kill(-pid, SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
