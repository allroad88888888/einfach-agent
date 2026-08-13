//! 同一目标路径上写入的互斥：进程内串行化与跨进程的归档写锁文件。

use super::limits::{
    ARCHIVE_LOCK_POLL, ARCHIVE_LOCK_STALE, ARCHIVE_LOCK_WAIT, PATH_LOCK_SWEEP_THRESHOLD,
};
use std::{
    collections::HashMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Serializes read-verify-write for a single target within this process, so the
/// optimistic guard cannot pass against content another in-flight write already
/// replaced. Cross-process races (an external editor) remain outside its reach.
pub(super) fn path_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|err| err.into_inner());
    if map.len() > PATH_LOCK_SWEEP_THRESHOLD {
        map.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Arc::clone(
        map.entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

pub(super) struct ArchivePathLock {
    path: PathBuf,
    token: String,
    heartbeat_stop: std::sync::mpsc::Sender<()>,
    heartbeat: Option<std::thread::JoinHandle<()>>,
}

impl ArchivePathLock {
    pub(super) fn acquire(target: &Path) -> Result<Self, String> {
        Self::acquire_with(target, ARCHIVE_LOCK_WAIT, ARCHIVE_LOCK_STALE)
    }

    fn acquire_with(target: &Path, wait: Duration, stale: Duration) -> Result<Self, String> {
        let lock_path = archive_lock_path(target)?;
        let started = SystemTime::now();
        let token = format!(
            "{}-{}",
            std::process::id(),
            started
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut file) => {
                    file.write_all(token.as_bytes()).map_err(|err| {
                        let _ = fs::remove_file(&lock_path);
                        format!("failed to initialize archive path lock: {err}")
                    })?;
                    let mut heartbeat_file = file.try_clone().map_err(|err| {
                        let _ = fs::remove_file(&lock_path);
                        format!("failed to initialize archive lock heartbeat: {err}")
                    })?;
                    let heartbeat_token = token.clone();
                    let (heartbeat_stop, heartbeat_receiver) = std::sync::mpsc::channel();
                    let heartbeat = thread::spawn(move || loop {
                        match heartbeat_receiver.recv_timeout(Duration::from_secs(5)) {
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if heartbeat_file.seek(SeekFrom::Start(0)).is_err()
                                    || heartbeat_file
                                        .write_all(heartbeat_token.as_bytes())
                                        .is_err()
                                    || heartbeat_file.flush().is_err()
                                {
                                    break;
                                }
                            }
                            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    });
                    return Ok(Self {
                        path: lock_path,
                        token,
                        heartbeat_stop,
                        heartbeat: Some(heartbeat),
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if archive_lock_is_stale(&lock_path, stale) {
                        let stale_path = lock_path.with_extension(format!("stale-{token}"));
                        if fs::rename(&lock_path, &stale_path).is_ok() {
                            let _ = fs::remove_file(stale_path);
                            continue;
                        }
                    }
                    if started.elapsed().unwrap_or_default() >= wait {
                        return Err(format!(
                            "timed out waiting for archive path lock `{}`",
                            lock_path.to_string_lossy()
                        ));
                    }
                    thread::sleep(ARCHIVE_LOCK_POLL);
                }
                Err(err) => return Err(format!("failed to acquire archive path lock: {err}")),
            }
        }
    }
}

impl Drop for ArchivePathLock {
    fn drop(&mut self) {
        let _ = self.heartbeat_stop.send(());
        if let Some(heartbeat) = self.heartbeat.take() {
            let _ = heartbeat.join();
        }
        if fs::read_to_string(&self.path).ok().as_deref() == Some(self.token.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn archive_lock_path(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| "archive path lock requires a file target".to_string())?
        .to_string_lossy();
    Ok(target.with_file_name(format!("{name}.archive-write.lock")))
}

fn archive_lock_is_stale(path: &Path, stale: Duration) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= stale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_write::test_support::unique_workspace;
    use std::sync::mpsc;

    #[test]
    fn archive_path_lock_serializes_owners() {
        let (base, ws) = unique_workspace();
        let target = ws.join("shared.jsonl");
        fs::write(&target, "").expect("create target");
        let first = ArchivePathLock::acquire(&target).expect("acquire first lock");
        let target_for_thread = target.clone();
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let lock = ArchivePathLock::acquire_with(
                &target_for_thread,
                Duration::from_secs(1),
                Duration::from_secs(30),
            )
            .expect("acquire second lock");
            sender.send(()).expect("report acquired");
            lock
        });

        assert!(receiver.recv_timeout(Duration::from_millis(60)).is_err());
        drop(first);
        receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("second owner should acquire after release");
        drop(thread.join().expect("join lock owner"));
        assert!(!archive_lock_path(&target).expect("lock path").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_archive_lock_recovery_does_not_remove_replacement() {
        let (base, ws) = unique_workspace();
        let target = ws.join("shared.jsonl");
        fs::write(&target, "").expect("create target");
        let first = ArchivePathLock::acquire(&target).expect("acquire first lock");
        let replacement =
            ArchivePathLock::acquire_with(&target, Duration::from_millis(100), Duration::ZERO)
                .expect("recover stale lock");
        drop(first);
        assert!(archive_lock_path(&target).expect("lock path").exists());
        drop(replacement);
        assert!(!archive_lock_path(&target).expect("lock path").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
