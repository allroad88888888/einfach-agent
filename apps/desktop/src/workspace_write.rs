use crate::workspace_change_journal::{
    discard_prepared_change, journal_dir, mark_change_applied, prepare_change_set, ChangeFileInput,
    WorkspaceChangeContext, WorkspaceChangeSummary,
};
use crate::workspace_common::{
    atomic_write, compute_change_summary, resolve_workspace_root, FileChangeSummary,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf, MAIN_SEPARATOR},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Hard ceiling on a single write. `max_bytes` is no longer part of the model-facing
/// schema, so an absent value means "the maximum", not a smaller default — capping it
/// lower here would silently reject writes the tool layer already accepted.
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Rollback stores full before/after text in the journal, so reversibility has a much
/// tighter budget than the write itself. Past this a write still succeeds, but reports
/// `reversible: false` instead of failing.
const REVERSIBLE_MAX_BYTES: usize = 1024 * 1024;
/// Path locks are cached per target; sweep the cache once it grows past this.
const PATH_LOCK_SWEEP_THRESHOLD: usize = 1024;
const ARCHIVE_LOCK_WAIT: Duration = Duration::from_secs(10);
const ARCHIVE_LOCK_STALE: Duration = Duration::from_secs(30);
const ARCHIVE_LOCK_POLL: Duration = Duration::from_millis(20);
const INDEX_COMPACT_MIN_BYTES: u64 = 128 * 1024;
const INDEX_COMPACT_THROTTLE: Duration = Duration::from_secs(5 * 60);
const INDEX_COMPACT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const PERF_LOG_TARGET: &str = "web_agent::perf";

struct WorkspaceWritePerf {
    operation_id: String,
    started_at: Instant,
    phase_started_at: Instant,
}

impl WorkspaceWritePerf {
    fn new(
        operation_id: String,
        content_bytes: usize,
        mode: Option<&str>,
        exclusive_path_lock: bool,
        journal_enabled: bool,
    ) -> Self {
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_write.start operation_id={} content_bytes={} mode={} exclusive_path_lock={} journal_enabled={}",
            operation_id,
            content_bytes,
            mode.unwrap_or("overwrite"),
            exclusive_path_lock,
            journal_enabled,
        );
        let now = Instant::now();
        Self {
            operation_id,
            started_at: now,
            phase_started_at: now,
        }
    }

    fn phase(&mut self, phase: &str) {
        let now = Instant::now();
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_write.phase operation_id={} phase={} phase_ms={:.1} total_ms={:.1}",
            self.operation_id,
            phase,
            now.duration_since(self.phase_started_at).as_secs_f64() * 1000.0,
            now.duration_since(self.started_at).as_secs_f64() * 1000.0,
        );
        self.phase_started_at = now;
    }

    fn finish(&self, result: &Result<WorkspaceWriteResult, String>) {
        let duration_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(value) => log::info!(
                target: PERF_LOG_TARGET,
                "workspace_write.finish operation_id={} status=ok duration_ms={:.1} bytes_written={} created={} overwritten={} appended={}",
                self.operation_id,
                duration_ms,
                value.bytes_written,
                value.created,
                value.overwritten,
                value.appended,
            ),
            Err(error) => log::error!(
                target: PERF_LOG_TARGET,
                "workspace_write.finish operation_id={} status=error duration_ms={:.1} reason={:?}",
                self.operation_id,
                duration_ms,
                error,
            ),
        }
    }
}

#[derive(Serialize)]
pub struct WorkspaceWriteResult {
    ok: bool,
    path: String,
    bytes_written: usize,
    created: bool,
    overwritten: bool,
    appended: bool,
    error: Option<String>,
    change_set: Option<WorkspaceChangeSummary>,
    /// What actually changed on disk, so the caller does not have to re-read the
    /// file to confirm the edit. Absent when the previous content was unreadable.
    change_summary: Option<FileChangeSummary>,
    /// Whether this write produced a rollback entry. Binary content and files past
    /// the reversible budget still get written — they just cannot be reverted, and
    /// say so rather than failing outright.
    reversible: bool,
    /// Why the write is not reversible. Only set when `reversible` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    reversible_reason: Option<String>,
    /// True when `dry_run` was requested: nothing was written, and the other fields
    /// describe what a real write would have done.
    dry_run: bool,
    would_change: bool,
}


#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteMode {
    Create,
    Overwrite,
    Append,
    Upsert,
}

/// Previous on-disk content, read once inside the path lock and then shared by
/// the optimistic guard, the rollback journal, and the change summary.
enum BeforeContent {
    Missing,
    Text(String),
    /// Present but not representable as reversible UTF-8 text; carries the reason
    /// so guard/journal callers can fail with the same message as before.
    Unsupported(String),
}

impl BeforeContent {
    fn existed(&self) -> bool {
        !matches!(self, BeforeContent::Missing)
    }

    fn text(&self) -> Option<&str> {
        match self {
            BeforeContent::Text(value) => Some(value.as_str()),
            _ => None,
        }
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn write_workspace_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    expected_content_hash: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root: Option<String>,
    encoding: Option<String>,
    executable: Option<bool>,
    dry_run: Option<bool>,
    change_context: Option<WorkspaceChangeContext>,
    diagnostic_operation_id: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    let operation_id = diagnostic_operation_id
        .or_else(|| {
            change_context
                .as_ref()
                .map(|context| context.change_id.clone())
        })
        .unwrap_or_else(|| {
            format!(
                "workspace-write-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    let journal_resolve_started_at = Instant::now();
    let journal = change_context
        .map(|context| journal_dir(&app).map(|directory| (directory, context)))
        .transpose()?;
    log::info!(
        target: PERF_LOG_TARGET,
        "workspace_write.host operation_id={} phase=journal_resolve phase_ms={:.1}",
        operation_id,
        journal_resolve_started_at.elapsed().as_secs_f64() * 1000.0,
    );
    tauri::async_runtime::spawn_blocking(move || {
        write_workspace_file_blocking_with_journal(
            path,
            content,
            mode,
            expected_old_content,
            expected_content_hash,
            create_dirs,
            max_bytes,
            exclusive_path_lock,
            workspace_root,
            encoding,
            executable,
            dry_run,
            journal,
            operation_id,
        )
    })
    .await
    .map_err(|err| format!("workspace write worker failed: {err}"))?
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn write_workspace_file_blocking(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    write_workspace_file_blocking_with_journal(
        path,
        content,
        mode,
        expected_old_content,
        None,
        create_dirs,
        max_bytes,
        exclusive_path_lock,
        workspace_root_arg,
        None,
        None,
        None,
        None,
        "workspace-write-test".to_string(),
    )
}

/// Test entry point for the options that are not part of the legacy positional helper.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn write_workspace_file_blocking_with_options(
    path: String,
    content: String,
    mode: Option<String>,
    workspace_root_arg: Option<String>,
    encoding: Option<String>,
    executable: Option<bool>,
    dry_run: Option<bool>,
) -> Result<WorkspaceWriteResult, String> {
    write_workspace_file_blocking_with_journal(
        path,
        content,
        mode,
        None,
        None,
        None,
        None,
        None,
        workspace_root_arg,
        encoding,
        executable,
        dry_run,
        None,
        "workspace-write-test".to_string(),
    )
}

#[allow(clippy::too_many_arguments)]
fn write_workspace_file_blocking_with_journal(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    expected_content_hash: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
    encoding: Option<String>,
    executable: Option<bool>,
    dry_run: Option<bool>,
    journal: Option<(PathBuf, WorkspaceChangeContext)>,
    diagnostic_operation_id: String,
) -> Result<WorkspaceWriteResult, String> {
    let dry_run = dry_run.unwrap_or(false);
    let mut perf = WorkspaceWritePerf::new(
        diagnostic_operation_id,
        content.len(),
        mode.as_deref(),
        exclusive_path_lock.unwrap_or(false),
        journal.is_some(),
    );
    let result = (|| -> Result<WorkspaceWriteResult, String> {
        let mode = match parse_mode(mode.as_deref()) {
            Ok(mode) => mode,
            Err(err) => return Ok(error_result(&path, err)),
        };
        let encoding = match parse_encoding(encoding.as_deref()) {
            Ok(encoding) => encoding,
            Err(err) => return Ok(error_result(&path, err)),
        };
        let guard_requested = expected_old_content.is_some() || expected_content_hash.is_some();
        // Append accepts guards too: without one, a retried chunked append cannot tell
        // "my write was lost" from "my write landed", so it can only duplicate content.
        if mode == WriteMode::Create && guard_requested {
            return Ok(error_result(
                &path,
                "optimistic guards are not valid with mode \"create\"; the file must not exist",
            ));
        }
        if expected_old_content.is_some() && expected_content_hash.is_some() {
            return Ok(error_result(
                &path,
                "pass either expectedOldContent or expectedContentHash, not both",
            ));
        }

        // One byte view for every mode; text-ness decides diffing and reversibility.
        let payload = match encoding {
            ContentEncoding::Utf8 => content.clone().into_bytes(),
            ContentEncoding::Base64 => match decode_base64(&content) {
                Ok(bytes) => bytes,
                Err(err) => return Ok(error_result(&path, err)),
            },
        };
        let payload_text = match encoding {
            ContentEncoding::Utf8 => Some(content.clone()),
            // Base64 is how binary arrives, but it is also a legitimate way to send text.
            // Recovering the text keeps diffs and rollback working for that case.
            ContentEncoding::Base64 => {
                String::from_utf8(payload.clone())
                    .ok()
                    .filter(|text| !text.contains('\0'))
            }
        };

        let max_bytes = normalize_max_bytes(max_bytes);
        let bytes = payload.len();
        if bytes > max_bytes {
            return Ok(error_result(
                &path,
                format!("content is too large: {bytes} bytes exceeds limit {max_bytes}"),
            ));
        }

        let workspace_root = match resolve_workspace_root(workspace_root_arg.as_deref()) {
            Ok(root) => root,
            Err(err) => return Ok(error_result(&path, err)),
        };
        let target_path = match resolve_workspace_path(&workspace_root, &path) {
            Ok(path) => path,
            Err(err) => return Ok(error_result(&path, err)),
        };
        // P2：返回相对 workspace root 的路径（与 read/list/patch 一致），不把 /Users/.../repo 这类
        // 绝对路径泄漏给 model 与聊天记录。
        let display_path = relative_path(&workspace_root, &target_path);
        perf.phase("validate_and_resolve");

        if let Some(parent) = target_path.parent() {
            if !parent.exists() {
                // Defaults to true, matching apply_patch. A missing parent directory
                // was the single most common first-write failure.
                if create_dirs.unwrap_or(true) {
                    if let Err(err) = fs::create_dir_all(parent) {
                        return Ok(error_result(
                            &display_path,
                            format!("failed to create parent directories: {err}"),
                        ));
                    }
                } else {
                    return Ok(error_result(
                        &display_path,
                        "parent directory does not exist; set createDirs=true to create it",
                    ));
                }
            }
        }
        perf.phase("prepare_parent");

        let _path_lock = if exclusive_path_lock.unwrap_or(false) {
            match ArchivePathLock::acquire(&target_path) {
                Ok(lock) => Some(lock),
                Err(err) => return Ok(error_result(&display_path, err)),
            }
        } else {
            None
        };
        perf.phase("exclusive_lock");

        if mode == WriteMode::Append && exclusive_path_lock.unwrap_or(false) {
            if let Err(err) = maybe_compact_subagent_index(&target_path) {
                return Ok(error_result(&display_path, err));
            }
        }
        perf.phase("archive_compaction");

        // Everything from here to the write is one critical section. The previous
        // content is read exactly once and shared by the optimistic guard, the
        // rollback journal and the change summary, so the guard can no longer pass
        // against content that a concurrent write in this process already replaced.
        let process_lock = path_lock(&target_path);
        let _process_guard = process_lock.lock().unwrap_or_else(|err| err.into_inner());
        perf.phase("path_lock");

        // Append never needs the old bytes for its own sake; only the journal does.
        let needs_before = journal.is_some()
            || guard_requested
            || matches!(mode, WriteMode::Overwrite | WriteMode::Upsert);
        let before = if needs_before {
            read_before_content(&target_path)
        } else {
            BeforeContent::Missing
        };
        let existed = if needs_before {
            before.existed()
        } else {
            target_path.exists()
        };
        perf.phase("read_before");

        // `upsert` collapses the read-probe round trip: it creates when absent and
        // overwrites when present, so callers do not have to know which it is.
        let effective_mode = match mode {
            WriteMode::Upsert if existed => WriteMode::Overwrite,
            WriteMode::Upsert => WriteMode::Create,
            other => other,
        };

        if mode == WriteMode::Overwrite && !existed {
            return Ok(error_result(
                &display_path,
                "cannot overwrite a file that does not exist; use mode \"upsert\" to create it when absent",
            ));
        }
        if effective_mode == WriteMode::Overwrite || (effective_mode == WriteMode::Append && existed)
        {
            if let Err(error) = verify_expected_content(
                &before,
                expected_old_content.as_deref(),
                expected_content_hash.as_deref(),
            ) {
                return Ok(error_result(&display_path, error));
            }
        } else if guard_requested {
            // Reached only via `upsert` on a missing file: the caller asserted a
            // specific previous state, so creating a fresh file would silently
            // discard that intent.
            return Ok(error_result(
                &display_path,
                "optimistic guard was provided but the file does not exist; drop the guard to create it",
            ));
        }
        perf.phase("verify_guard");

        // The full post-write content, when it is representable as text. `None` means
        // binary (or an unreadable previous file), which is exactly the condition that
        // makes a write non-reversible and undiffable.
        let after_text = match effective_mode {
            WriteMode::Create | WriteMode::Overwrite => payload_text.clone(),
            WriteMode::Append => match (&before, &payload_text) {
                (_, None) => None,
                (BeforeContent::Missing, Some(appended)) => Some(appended.clone()),
                (BeforeContent::Text(existing), Some(appended)) => {
                    Some(format!("{existing}{appended}"))
                }
                (BeforeContent::Unsupported(_), _) => None,
            },
            WriteMode::Upsert => unreachable!("upsert is resolved into create/overwrite above"),
        };

        // Reversibility is a property of the content, not a precondition for writing.
        // Binary artifacts and oversized files used to be rejected outright; now they
        // are written and reported as non-reversible, so the capability exists and the
        // limitation is visible instead of silent.
        let reversible_reason: Option<String> = match (&before, &after_text) {
            (BeforeContent::Unsupported(reason), _) => Some(reason.clone()),
            (_, None) => Some("binary content is not reversible".to_string()),
            (_, Some(after)) if after.len() > REVERSIBLE_MAX_BYTES => Some(format!(
                "resulting file exceeds the reversible {REVERSIBLE_MAX_BYTES} byte limit"
            )),
            _ => None,
        };

        let prepared_change = match (journal.as_ref(), &reversible_reason, &after_text) {
            (Some((directory, context)), None, Some(after)) => {
                let journal_before = before.text().map(str::to_string);
                match prepare_change_set(
                    directory,
                    context.clone(),
                    &workspace_root,
                    vec![ChangeFileInput {
                        path: display_path.clone(),
                        before: journal_before,
                        after: Some(after.clone()),
                    }],
                ) {
                    Ok(summary) => Some((directory.clone(), summary)),
                    Err(error) => return Ok(error_result(&display_path, error)),
                }
            }
            _ => None,
        };
        perf.phase("journal_prepare");

        let change_summary = match (&before, &after_text) {
            (_, None) => None,
            (BeforeContent::Text(previous), Some(after)) => {
                Some(compute_change_summary(Some(previous), after))
            }
            (BeforeContent::Missing, Some(after)) if !existed => {
                Some(compute_change_summary(None, after))
            }
            _ => None,
        };

        // dry_run stops here: every check that could reject the write has already run,
        // so the caller learns whether it would be accepted and what it would change.
        if dry_run {
            if let Some((directory, summary)) = prepared_change.as_ref() {
                discard_prepared_change(directory, &summary.id);
            }
            let would_change = change_summary
                .as_ref()
                .map(|summary| summary.lines_added > 0 || summary.lines_removed > 0)
                .unwrap_or(true);
            perf.phase("dry_run");
            return Ok(WorkspaceWriteResult {
                ok: true,
                path: display_path,
                bytes_written: 0,
                created: !existed,
                overwritten: effective_mode == WriteMode::Overwrite,
                appended: effective_mode == WriteMode::Append,
                error: None,
                change_set: None,
                change_summary,
                reversible: reversible_reason.is_none(),
                reversible_reason,
                dry_run: true,
                would_change,
            });
        }

        let write_result = match effective_mode {
            // `create` keeps O_EXCL: refusing an existing file is the whole point of
            // the mode, and a rename would defeat it.
            WriteMode::Create => write_create(&target_path, &payload),
            // Overwrite goes through a temp file + rename so a crash mid-write can
            // never leave the target truncated or half-written.
            WriteMode::Overwrite => atomic_write(&target_path, &payload),
            WriteMode::Append => write_append(&target_path, &payload),
            WriteMode::Upsert => unreachable!("upsert is resolved into create/overwrite above"),
        }
        .and_then(|()| match executable {
            Some(executable) => apply_executable_bit(&target_path, executable),
            None => Ok(()),
        });
        perf.phase("file_write");

        let result = match write_result {
            Ok(()) => {
                if let Some((directory, summary)) = prepared_change.as_ref() {
                    if let Err(error) = mark_change_applied(directory, &summary.id) {
                        log::warn!("failed to mark workspace change as applied: {error}");
                    }
                }
                Ok(WorkspaceWriteResult {
                    ok: true,
                    path: display_path,
                    bytes_written: bytes,
                    created: !existed,
                    overwritten: effective_mode == WriteMode::Overwrite,
                    appended: effective_mode == WriteMode::Append,
                    error: None,
                    change_set: prepared_change.map(|(_, summary)| summary),
                    change_summary,
                    reversible: reversible_reason.is_none(),
                    reversible_reason,
                    dry_run: false,
                    would_change: true,
                })
            }
            Err(err) => {
                if let Some((directory, summary)) = prepared_change.as_ref() {
                    discard_prepared_change(directory, &summary.id);
                }
                Ok(error_result(&display_path, err))
            }
        };
        perf.phase("journal_finalize");
        result
    })();
    perf.finish(&result);
    result
}

/// Read the current content once for the guard, the journal and the diff.
///
/// Unreadable-but-present files are reported as `Unsupported` rather than as an
/// error: only callers that actually need the old bytes (an optimistic guard, or
/// a journaled write that must stay reversible) reject them, so a plain overwrite
/// of a large or binary file keeps working and merely loses its change summary.
fn read_before_content(path: &Path) -> BeforeContent {
    let Ok(metadata) = fs::metadata(path) else {
        return BeforeContent::Missing;
    };
    if !metadata.is_file() {
        return BeforeContent::Unsupported("rollback only supports regular files".to_string());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return BeforeContent::Unsupported(format!(
            "existing file exceeds reversible {MAX_BYTES} byte limit"
        ));
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return BeforeContent::Unsupported(format!("failed to read file for rollback: {error}"))
        }
    };
    if bytes.contains(&0) {
        return BeforeContent::Unsupported("binary files are not reversible".to_string());
    }
    match String::from_utf8(bytes) {
        Ok(text) => BeforeContent::Text(text),
        Err(_) => BeforeContent::Unsupported("non-UTF-8 files are not reversible".to_string()),
    }
}

/// Serializes read-verify-write for a single target within this process, so the
/// optimistic guard cannot pass against content another in-flight write already
/// replaced. Cross-process races (an external editor) remain outside its reach.
fn path_lock(path: &Path) -> Arc<Mutex<()>> {
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


struct ArchivePathLock {
    path: PathBuf,
    token: String,
    heartbeat_stop: std::sync::mpsc::Sender<()>,
    heartbeat: Option<std::thread::JoinHandle<()>>,
}

impl ArchivePathLock {
    fn acquire(target: &Path) -> Result<Self, String> {
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

fn maybe_compact_subagent_index(path: &Path) -> Result<(), String> {
    let Some(name) = subagent_index_name(path) else {
        return Ok(());
    };
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "failed to inspect {name} index for compaction: {err}"
            ))
        }
    };
    if metadata.len() < INDEX_COMPACT_MIN_BYTES {
        return Ok(());
    }
    if metadata.len() > INDEX_COMPACT_MAX_BYTES {
        return Err(format!(
            "{name} index exceeds automatic compaction limit of {INDEX_COMPACT_MAX_BYTES} bytes"
        ));
    }

    let marker = path.with_file_name(format!(".{name}.compact-at"));
    if fs::metadata(&marker)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < INDEX_COMPACT_THROTTLE)
    {
        return Ok(());
    }

    let text = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {name} index for compaction: {err}"))?;
    let compacted = compact_subagent_index(name, &text)?;
    atomic_replace(path, compacted.as_bytes(), "compact")?;
    fs::write(&marker, now_millis().to_string())
        .map_err(|err| format!("failed to update {name} compaction marker: {err}"))?;
    Ok(())
}

fn subagent_index_name(path: &Path) -> Option<&'static str> {
    let filename = path.file_name()?.to_str()?;
    let name = match filename {
        "runs.jsonl" => "runs",
        "skills.jsonl" => "skills",
        "agents.jsonl" => "agents",
        _ => return None,
    };
    let parent = path.parent()?;
    if parent.file_name()?.to_str()? != "index"
        || parent.parent()?.file_name()?.to_str()? != ".webAgent-archive"
    {
        return None;
    }
    Some(name)
}

fn compact_subagent_index(name: &str, text: &str) -> Result<String, String> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, (usize, serde_json::Value)> = HashMap::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(line)
            .map_err(|err| format!("{name} index line {}: invalid JSON ({err})", index + 1))?;
        let object = record
            .as_object()
            .ok_or_else(|| format!("{name} index line {}: record must be an object", index + 1))?;
        let field = |key: &str| {
            object
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let key = if name == "skills" {
            field("skillId")
                .ok_or_else(|| format!("skills index line {}: record requires skillId", index + 1))?
                .to_string()
        } else {
            let conversation = field("conversationId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            let run = field("runId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            if name == "runs" {
                format!("{conversation}\0{run}")
            } else {
                let agent_path = field("path").ok_or_else(|| {
                    format!("agents index line {}: record requires path", index + 1)
                })?;
                format!("{conversation}\0{run}\0{agent_path}")
            }
        };
        latest.insert(key, (index, record));
    }
    let mut records: Vec<_> = latest.into_values().collect();
    records.sort_by_key(|(index, _)| *index);
    let mut output = String::new();
    for (_, record) in records {
        output.push_str(
            &serde_json::to_string(&record)
                .map_err(|err| format!("failed to serialize compacted {name} index: {err}"))?,
        );
        output.push('\n');
    }
    Ok(output)
}

fn atomic_replace(path: &Path, content: &[u8], suffix: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{suffix}-{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    fs::write(&temporary, content)
        .map_err(|err| format!("failed to write temporary index: {err}"))?;
    let result = fs::rename(&temporary, path)
        .map_err(|err| format!("failed to replace compacted index: {err}"));
    let _ = fs::remove_file(temporary);
    result
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

// P2：把绝对路径转成相对 workspace root 的斜杠路径（与 workspace_read 同语义）——
// 结果 path 对外一律 workspace 相对，不泄漏本机绝对路径。root 外的意外路径回退为原样。
fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    path_to_slash_string(relative)
}

fn path_to_slash_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    if MAIN_SEPARATOR == '/' {
        text.into_owned()
    } else {
        text.replace(MAIN_SEPARATOR, "/")
    }
}

fn write_create(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                "file already exists; use mode \"overwrite\" only when replacing it is intentional"
                    .to_string()
            } else {
                to_io_error(err)
            }
        })
}

fn write_append(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

/// Verifies the optimistic guard against content already read inside the path
/// lock, rather than re-reading the file, so no window remains between the check
/// and the write it protects.
fn verify_expected_content(
    before: &BeforeContent,
    expected: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    if expected.is_some() && expected_hash.is_some() {
        return Err("pass either expectedOldContent or expectedContentHash, not both".to_string());
    }
    if expected.is_none() && expected_hash.is_none() {
        return Ok(());
    }

    let current = match before {
        BeforeContent::Text(value) => value.as_str(),
        BeforeContent::Missing => {
            return Err(
                "failed to read existing file for optimistic guard: file does not exist".to_string(),
            )
        }
        BeforeContent::Unsupported(reason) => {
            return Err(format!(
                "failed to read existing file for optimistic guard: {reason}"
            ))
        }
    };
    if let Some(expected) = expected {
        if current != expected {
            return Err(format!(
                "expectedOldContent does not match current file content \
                 (expected_bytes={}, current_bytes={}, first_mismatch_byte={}, \
                 expected_trailing_lf={}, current_trailing_lf={}). Re-read the complete, \
                 untruncated file and pass it exactly, including final newlines; do not pass a snippet",
                expected.len(),
                current.len(),
                first_mismatch_byte(expected.as_bytes(), current.as_bytes()),
                trailing_lf_count(expected.as_bytes()),
                trailing_lf_count(current.as_bytes()),
            ));
        }
    }
    if let Some(expected_hash) = expected_hash {
        validate_content_hash(expected_hash)?;
        if content_sha256(current.as_bytes()) != expected_hash {
            return Err(
                "expectedContentHash does not match current file content; the file changed after \
                 read_file. Re-read it and retry with the new contentHash"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_content_hash(value: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(
            "expectedContentHash must use sha256:<64 lowercase hex characters>".to_string(),
        );
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "expectedContentHash must use sha256:<64 lowercase hex characters>".to_string(),
        );
    }
    Ok(())
}

fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn first_mismatch_byte(expected: &[u8], current: &[u8]) -> usize {
    expected
        .iter()
        .zip(current)
        .position(|(left, right)| left != right)
        .unwrap_or(expected.len().min(current.len()))
}

fn trailing_lf_count(content: &[u8]) -> usize {
    content
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\n')
        .count()
}

fn parse_mode(mode: Option<&str>) -> Result<WriteMode, String> {
    match mode.unwrap_or("create") {
        "create" => Ok(WriteMode::Create),
        "overwrite" => Ok(WriteMode::Overwrite),
        "append" => Ok(WriteMode::Append),
        "upsert" => Ok(WriteMode::Upsert),
        other => Err(format!(
            "invalid mode `{other}`; expected `create`, `overwrite`, `upsert`, or `append`"
        )),
    }
}

fn normalize_max_bytes(max_bytes: Option<usize>) -> usize {
    match max_bytes {
        Some(value) if value > 0 => value.min(MAX_BYTES),
        _ => MAX_BYTES,
    }
}

/// How `content` is carried over IPC. Base64 exists so the tool can produce binary
/// artifacts at all; JSON strings cannot hold arbitrary bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ContentEncoding {
    Utf8,
    Base64,
}

fn parse_encoding(encoding: Option<&str>) -> Result<ContentEncoding, String> {
    match encoding.unwrap_or("utf8") {
        "utf8" | "utf-8" => Ok(ContentEncoding::Utf8),
        "base64" => Ok(ContentEncoding::Base64),
        other => Err(format!(
            "invalid encoding `{other}`; expected `utf8` or `base64`"
        )),
    }
}

/// Minimal RFC 4648 base64 decoder. Vendored rather than pulled in as a dependency:
/// this is the only place the app needs base64, and the whole contract is 30 lines.
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    // Whitespace is legal padding in transport; anything else must be real base64.
    let symbols: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let body = symbols.strip_suffix(b"==").unwrap_or_else(|| {
        symbols
            .strip_suffix(b"=")
            .unwrap_or(symbols.as_slice())
    });
    let padding = symbols.len() - body.len();
    if padding > 2 || (symbols.len() % 4 != 0 && padding > 0) {
        return Err("content is not valid base64: malformed padding".to_string());
    }

    let mut output = Vec::with_capacity(body.len() / 4 * 3 + 3);
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for byte in body {
        let Some(decoded) = value(*byte) else {
            return Err(format!(
                "content is not valid base64: unexpected character `{}`",
                char::from(*byte).escape_default()
            ));
        };
        accumulator = (accumulator << 6) | decoded;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    // Leftover bits must be zero padding; anything else means truncated input.
    if bits >= 6 || (accumulator & ((1 << bits) - 1)) != 0 {
        return Err("content is not valid base64: truncated input".to_string());
    }
    Ok(output)
}

/// Apply an explicit executable request after the content is in place. A no-op on
/// platforms without a POSIX mode.
#[cfg(unix)]
fn apply_executable_bit(path: &Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to inspect file mode: {err}"))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    // Mirror the read bits: a file readable by group/other becomes executable by them too.
    let updated = if executable {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode & !0o111
    };
    if updated == mode {
        return Ok(());
    }
    permissions.set_mode(updated);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("failed to update file mode: {err}"))
}

#[cfg(not(unix))]
fn apply_executable_bit(_path: &Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

fn resolve_workspace_path(workspace_root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path cannot contain NUL bytes".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    let joined = if input_path.is_absolute() {
        input_path
    } else {
        workspace_root.join(input_path)
    };
    let normalized = normalize_path(&joined)?;
    if !is_within_workspace(workspace_root, &normalized) {
        return Err("path must stay within the workspace root".to_string());
    }

    resolve_existing_ancestor(workspace_root, &normalized)
}

fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path must not contain `..` components".to_string());
            }
            Component::Normal(part) => normalized.push(part),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

fn resolve_existing_ancestor(workspace_root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.exists() {
        let canonical = fs::canonicalize(target).map_err(|err| {
            format!(
                "failed to resolve target path `{}`: {err}",
                target.to_string_lossy()
            )
        })?;
        if !is_within_workspace(workspace_root, &canonical) {
            return Err("path must stay within the workspace root".to_string());
        }
        return Ok(canonical);
    }

    let mut missing = Vec::new();
    let mut cursor = target;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            return Err(format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            ));
        };
        missing.push(name.to_owned());
        cursor = cursor.parent().ok_or_else(|| {
            format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            )
        })?;
    }

    let mut resolved = fs::canonicalize(cursor).map_err(|err| {
        format!(
            "failed to resolve ancestor `{}`: {err}",
            cursor.to_string_lossy()
        )
    })?;
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }

    for part in missing.iter().rev() {
        resolved.push(part);
    }
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }
    Ok(resolved)
}

fn is_within_workspace(workspace_root: &Path, target: &Path) -> bool {
    target == workspace_root || target.starts_with(workspace_root)
}

fn error_result(path: &str, error: impl Into<String>) -> WorkspaceWriteResult {
    WorkspaceWriteResult {
        ok: false,
        path: path.to_string(),
        bytes_written: 0,
        created: false,
        overwritten: false,
        appended: false,
        error: Some(error.into()),
        change_set: None,
        change_summary: None,
        reversible: false,
        reversible_reason: None,
        dry_run: false,
        would_change: false,
    }
}

fn to_io_error(err: std::io::Error) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    // 真写磁盘的集成测试：create 模式真在磁盘落文件（含 create_dirs 建父目录），
    // 且 confine 拒 ../ 与 workspace 外绝对路径，越界时磁盘上不留任何文件。
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    // (base, workspace)：base 唯一且 canonicalize；workspace = base/ws 也 canonicalize。
    fn unique_workspace() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut base = std::env::temp_dir();
        base.push(format!("ws_write_it_{}_{}", std::process::id(), seq));
        fs::create_dir_all(&base).expect("create base");
        let base = fs::canonicalize(&base).expect("canonicalize base");
        let ws = base.join("ws");
        fs::create_dir_all(&ws).expect("create ws");
        let ws = fs::canonicalize(&ws).expect("canonicalize ws");
        (base, ws)
    }

    fn root_arg(ws: &Path) -> Option<String> {
        Some(ws.to_string_lossy().into_owned())
    }

    #[test]
    fn create_writes_file_to_disk() {
        // create 模式：磁盘上真出现文件且内容正确，path 为 workspace 相对，created=true。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "out/hello.txt".to_string(),
            "written content".to_string(),
            Some("create".to_string()),
            None,
            Some(true), // create_dirs：out/ 不存在，需自动建
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(result.ok, "create 应成功，错误: {:?}", result.error);
        assert!(result.created, "应标记为新建");
        assert_eq!(result.path, "out/hello.txt", "path 应为 workspace 相对路径");

        let on_disk = fs::read_to_string(ws.join("out/hello.txt")).expect("文件应真出现在磁盘");
        assert_eq!(on_disk, "written content", "磁盘内容应与写入一致");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn create_existing_file_returns_actionable_error() {
        let (base, ws) = unique_workspace();
        fs::write(ws.join("existing.txt"), "old").expect("seed existing file");

        let result = write_workspace_file_blocking(
            "existing.txt".to_string(),
            "new".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker layer should return a structured rejection");

        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some(
                "file already exists; use mode \"overwrite\" only when replacing it is intentional"
            )
        );
        assert_eq!(
            fs::read_to_string(ws.join("existing.txt")).expect("existing file remains readable"),
            "old"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn expected_old_content_mismatch_reports_exact_difference_shape() {
        let (base, ws) = unique_workspace();
        let target = ws.join("existing.txt");
        fs::write(&target, "line\n\n").expect("seed existing file");

        let error = verify_expected_content(&read_before_content(&target), Some("line\n"), None)
            .expect_err("different final newline count must reject");

        assert!(error.contains("expected_bytes=5"));
        assert!(error.contains("current_bytes=6"));
        assert!(error.contains("first_mismatch_byte=5"));
        assert!(error.contains("expected_trailing_lf=1"));
        assert!(error.contains("current_trailing_lf=2"));
        assert!(error.contains("do not pass a snippet"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn expected_content_hash_accepts_current_and_rejects_stale_content() {
        let (base, ws) = unique_workspace();
        let target = ws.join("existing.txt");
        fs::write(&target, "old\n\n").expect("seed existing file");
        let current_hash = content_sha256(b"old\n\n");

        verify_expected_content(&read_before_content(&target), None, Some(&current_hash))
            .expect("matching content hash should pass");
        fs::write(&target, "changed\n").expect("modify existing file");
        let error = verify_expected_content(&read_before_content(&target), None, Some(&current_hash))
            .expect_err("stale content hash must reject");

        assert!(error.contains("file changed after read_file"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn upsert_creates_when_absent_and_overwrites_when_present() {
        let (base, ws) = unique_workspace();

        let created = write_workspace_file_blocking(
            "notes/entry.txt".to_string(),
            "first".to_string(),
            Some("upsert".to_string()),
            None,
            None, // create_dirs 默认应为 true
            None,
            None,
            root_arg(&ws),
        )
        .expect("upsert create");
        assert!(created.ok, "upsert 应能新建，错误: {:?}", created.error);
        assert!(created.created, "缺失文件时 upsert 记为新建");
        assert!(!created.overwritten);

        let replaced = write_workspace_file_blocking(
            "notes/entry.txt".to_string(),
            "second".to_string(),
            Some("upsert".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("upsert overwrite");
        assert!(replaced.ok, "错误: {:?}", replaced.error);
        assert!(!replaced.created, "已存在文件时 upsert 记为覆盖");
        assert!(replaced.overwritten);
        assert_eq!(
            fs::read_to_string(ws.join("notes/entry.txt")).expect("read back"),
            "second"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn overwrite_on_missing_file_points_at_upsert() {
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "absent.txt".to_string(),
            "x".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("structured rejection");

        assert!(!result.ok);
        assert!(
            result.error.as_deref().unwrap_or_default().contains("upsert"),
            "错误应指向 upsert，实际: {:?}",
            result.error
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn upsert_with_guard_refuses_to_create_a_missing_file() {
        // guard 表达的是"我基于某个已知版本改"。文件不存在时静默新建会丢掉这个前提。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "absent.txt".to_string(),
            "x".to_string(),
            Some("upsert".to_string()),
            Some("expected old".to_string()),
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("structured rejection");

        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("does not exist"));
        assert!(!ws.join("absent.txt").exists(), "被拒时不应留下文件");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_preserves_the_executable_bit() {
        // 原子写是 temp+rename，rename 会带走 temp 的 umask 权限；不显式回填就会把
        // 脚本的可执行位悄悄抹掉。
        use std::os::unix::fs::PermissionsExt;
        let (base, ws) = unique_workspace();
        let target = ws.join("run.sh");
        fs::write(&target, "#!/bin/sh\necho old\n").expect("seed script");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).expect("chmod");

        let result = write_workspace_file_blocking(
            "run.sh".to_string(),
            "#!/bin/sh\necho new\n".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("overwrite script");
        assert!(result.ok, "错误: {:?}", result.error);

        let mode = fs::metadata(&target).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "覆盖后应保留可执行位");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_leaves_no_temporary_files_behind() {
        let (base, ws) = unique_workspace();
        let target = ws.join("data.txt");
        fs::write(&target, "old\n").expect("seed");

        write_workspace_file_blocking(
            "data.txt".to_string(),
            "new\n".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("overwrite")
        .ok
        .then_some(())
        .expect("overwrite should succeed");

        let leftovers: Vec<_> = fs::read_dir(&ws)
            .expect("read workspace")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {leftovers:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_encoding_writes_real_binary_bytes() {
        // 二进制产出以前是硬拒（content 含 \0 直接失败），shell 侧又被写保护挡死，
        // 等于 agent 完全无法产出二进制文件。
        let (base, ws) = unique_workspace();
        let png_header = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

        let result = write_workspace_file_blocking_with_options(
            "assets/pixel.png".to_string(),
            "iVBORw0KGgoA/w==".to_string(),
            Some("create".to_string()),
            root_arg(&ws),
            Some("base64".to_string()),
            None,
            None,
        )
        .expect("binary write");

        assert!(result.ok, "错误: {:?}", result.error);
        assert_eq!(
            fs::read(ws.join("assets/pixel.png")).expect("read back"),
            png_header
        );
        // 二进制可以写，但 journal 只能存文本，所以必须明说它不可回滚。
        assert!(!result.reversible);
        assert!(result
            .reversible_reason
            .as_deref()
            .unwrap_or_default()
            .contains("binary"));
        assert!(result.change_summary.is_none(), "二进制没有行级 diff");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_carrying_text_stays_diffable_and_reversible() {
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking_with_options(
            "note.txt".to_string(),
            "aGVsbG8K".to_string(), // "hello\n"
            Some("create".to_string()),
            root_arg(&ws),
            Some("base64".to_string()),
            None,
            None,
        )
        .expect("base64 text write");

        assert!(result.ok);
        assert_eq!(
            fs::read_to_string(ws.join("note.txt")).expect("read back"),
            "hello\n"
        );
        assert!(result.reversible, "base64 承载的文本仍然可回滚");
        assert_eq!(
            result.change_summary.expect("summary").lines_added,
            1,
            "base64 承载的文本仍然有 diff"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn malformed_base64_is_rejected_before_touching_disk() {
        let (base, ws) = unique_workspace();
        // "a" 单字符只剩 6 个有效位，凑不出一个字节；"==" 是纯 padding；"!" 非法字符。
        for payload in ["not base64!", "a", "=="] {
            let result = write_workspace_file_blocking_with_options(
                "bad.bin".to_string(),
                payload.to_string(),
                Some("create".to_string()),
                root_arg(&ws),
                Some("base64".to_string()),
                None,
                None,
            )
            .expect("structured rejection");
            assert!(!result.ok, "`{payload}` 应被拒");
            assert!(result
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("base64"));
        }
        assert!(!ws.join("bad.bin").exists(), "被拒时不应留下文件");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_decoder_matches_rfc4648_vectors() {
        assert_eq!(decode_base64("").expect("empty"), b"");
        assert_eq!(decode_base64("Zg==").expect("f"), b"f");
        assert_eq!(decode_base64("Zm8=").expect("fo"), b"fo");
        assert_eq!(decode_base64("Zm9v").expect("foo"), b"foo");
        assert_eq!(decode_base64("Zm9vYmFy").expect("foobar"), b"foobar");
        // 传输中换行是合法的，内容里的换行不影响解码结果。
        assert_eq!(decode_base64("Zm9v\nYmFy").expect("wrapped"), b"foobar");
        // 省略 padding 是 RFC 4648 允许的，模型生成的 base64 未必带 `=`。
        assert_eq!(decode_base64("Zm8").expect("unpadded fo"), b"fo");
        assert_eq!(decode_base64("Zg").expect("unpadded f"), b"f");
    }

    #[cfg(unix)]
    #[test]
    fn executable_flag_sets_and_clears_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (base, ws) = unique_workspace();

        let created = write_workspace_file_blocking_with_options(
            "bin/run.sh".to_string(),
            "#!/bin/sh\n".to_string(),
            Some("create".to_string()),
            root_arg(&ws),
            None,
            Some(true),
            None,
        )
        .expect("create executable");
        assert!(created.ok, "错误: {:?}", created.error);
        let mode = fs::metadata(ws.join("bin/run.sh"))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o100, 0o100, "owner 执行位应被置上");

        let cleared = write_workspace_file_blocking_with_options(
            "bin/run.sh".to_string(),
            "#!/bin/sh\necho hi\n".to_string(),
            Some("overwrite".to_string()),
            root_arg(&ws),
            None,
            Some(false),
            None,
        )
        .expect("clear executable");
        assert!(cleared.ok);
        let mode = fs::metadata(ws.join("bin/run.sh"))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0, "显式 false 应清掉执行位");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dry_run_reports_the_change_without_writing() {
        let (base, ws) = unique_workspace();
        fs::write(ws.join("code.txt"), "keep\nold\n").expect("seed");

        let result = write_workspace_file_blocking_with_options(
            "code.txt".to_string(),
            "keep\nnew\n".to_string(),
            Some("overwrite".to_string()),
            root_arg(&ws),
            None,
            None,
            Some(true),
        )
        .expect("dry run");

        assert!(result.ok);
        assert!(result.dry_run);
        assert!(result.would_change);
        assert_eq!(result.bytes_written, 0);
        assert!(result.change_set.is_none(), "dry run 不产生可回滚记录");
        let summary = result.change_summary.expect("summary");
        assert_eq!(summary.lines_added, 1);
        assert_eq!(summary.lines_removed, 1);
        assert_eq!(
            fs::read_to_string(ws.join("code.txt")).expect("read back"),
            "keep\nold\n",
            "dry run 不能改动磁盘"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dry_run_still_reports_a_guard_mismatch() {
        // dry run 的价值就在于能提前知道这次写会不会被拒。
        let (base, ws) = unique_workspace();
        let target = ws.join("code.txt");
        fs::write(&target, "current\n").expect("seed");

        let result = write_workspace_file_blocking_with_journal(
            "code.txt".to_string(),
            "next\n".to_string(),
            Some("overwrite".to_string()),
            Some("stale\n".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
            None,
            None,
            Some(true),
            None,
            "dry-guard".to_string(),
        )
        .expect("structured rejection");

        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("expectedOldContent"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn append_accepts_an_optimistic_guard() {
        // 分块追加失败重试时，没有前置条件就无法区分「上次写丢了」和「上次写成功了」。
        let (base, ws) = unique_workspace();
        let target = ws.join("log.jsonl");
        fs::write(&target, "one\n").expect("seed");
        let current_hash = content_sha256(b"one\n");

        let appended = write_workspace_file_blocking(
            "log.jsonl".to_string(),
            "two\n".to_string(),
            Some("append".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("plain append");
        assert!(appended.ok);

        // 文件已经变了，旧 hash 必须挡住重复追加。
        let stale = write_workspace_file_blocking_with_journal(
            "log.jsonl".to_string(),
            "two\n".to_string(),
            Some("append".to_string()),
            None,
            Some(current_hash),
            None,
            None,
            None,
            root_arg(&ws),
            None,
            None,
            None,
            None,
            "append-guard".to_string(),
        )
        .expect("structured rejection");

        assert!(!stale.ok, "过期 hash 必须拒绝重复追加");
        assert_eq!(
            fs::read_to_string(&target).expect("read back"),
            "one\ntwo\n",
            "被拒的追加不能落盘"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn oversized_text_is_written_but_marked_non_reversible() {
        // 以前超过可逆上限直接失败，等于「太大就不给写」。现在照写，只是标明不可回滚。
        let (base, ws) = unique_workspace();
        let big = "x".repeat(REVERSIBLE_MAX_BYTES + 1024);

        let result = write_workspace_file_blocking_with_options(
            "big.txt".to_string(),
            big.clone(),
            Some("create".to_string()),
            root_arg(&ws),
            None,
            None,
            None,
        )
        .expect("large write");

        assert!(result.ok, "错误: {:?}", result.error);
        assert_eq!(result.bytes_written, big.len());
        assert!(!result.reversible);
        assert!(result
            .reversible_reason
            .as_deref()
            .unwrap_or_default()
            .contains("reversible"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn absent_max_bytes_allows_writes_past_the_old_default() {
        // max_bytes 已不在模型可见的 schema 里；不传必须等于「用最大上限」，
        // 否则工具层放行的内容会在 host 侧被静默拒绝。
        let (base, ws) = unique_workspace();
        let content = "y".repeat(600 * 1024);

        let result = write_workspace_file_blocking(
            "medium.txt".to_string(),
            content.clone(),
            Some("create".to_string()),
            None,
            None,
            None, // max_bytes 缺省
            None,
            root_arg(&ws),
        )
        .expect("write");

        assert!(result.ok, "600KB 不应被拒: {:?}", result.error);
        assert_eq!(result.bytes_written, content.len());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn change_summary_reports_the_edited_region_only() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nb\nCHANGED\nd\ne\n";
        let summary = compute_change_summary(Some(before), after);

        assert_eq!(summary.lines_added, 1);
        assert_eq!(summary.lines_removed, 1);
        assert_eq!(summary.before_lines, 5);
        assert_eq!(summary.after_lines, 5);
        assert!(!summary.approximate);
        assert!(!summary.diff_truncated);
        let diff = summary.diff.expect("diff present");
        assert!(diff.contains("-c"), "diff 应含删除行: {diff}");
        assert!(diff.contains("+CHANGED"), "diff 应含新增行: {diff}");
        assert!(!diff.contains("+a"), "未变动的头部不应进 diff: {diff}");
    }

    #[test]
    fn change_summary_for_a_new_file_counts_every_line_as_added() {
        let summary = compute_change_summary(None, "one\ntwo\n");
        assert_eq!(summary.lines_added, 2);
        assert_eq!(summary.lines_removed, 0);
        assert_eq!(summary.before_lines, 0);
        assert_eq!(summary.after_lines, 2);
    }

    #[test]
    fn identical_content_reports_no_change_and_no_diff() {
        let summary = compute_change_summary(Some("same\n"), "same\n");
        assert_eq!(summary.lines_added, 0);
        assert_eq!(summary.lines_removed, 0);
        assert!(summary.diff.is_none());
    }

    #[test]
    fn oversized_edits_degrade_to_an_approximate_block_summary() {
        // 超出 LCS 预算时不能假装算得出最小 diff：整段按替换上报并标记 approximate。
        let before: String = (0..1200).map(|index| format!("before {index}\n")).collect();
        let after: String = (0..1200).map(|index| format!("after {index}\n")).collect();
        let summary = compute_change_summary(Some(&before), &after);

        assert!(summary.approximate, "应降级为近似摘要");
        assert_eq!(summary.lines_removed, 1200);
        assert_eq!(summary.lines_added, 1200);
        assert!(summary.diff_truncated, "diff 应被截断");
        let diff = summary.diff.expect("diff present");
        // 头部 hunk 行 + 截断提示行，所以比纯 diff 预算多两行。
        assert!(diff.lines().count() <= 62);
        assert!(diff.contains("more diff lines"));
    }

    #[test]
    fn successful_overwrite_returns_a_change_summary() {
        let (base, ws) = unique_workspace();
        fs::write(ws.join("code.txt"), "keep\nold\n").expect("seed");

        let result = write_workspace_file_blocking(
            "code.txt".to_string(),
            "keep\nnew\n".to_string(),
            Some("overwrite".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("overwrite");

        let summary = result.change_summary.expect("summary present");
        assert_eq!(summary.lines_added, 1);
        assert_eq!(summary.lines_removed, 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_parent_escape() {
        // ../ 越界写：结构化失败(ok=false，error 含 ..)，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "../evil.txt".to_string(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "../ 越界写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(err.contains(".."), "应因 .. 被拒，实际: {err}");
        assert!(!base.join("evil.txt").exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_absolute_outside_path() {
        // workspace 外绝对路径写：ok=false，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let outside = base.join("evil.txt");
        let result = write_workspace_file_blocking(
            outside.to_string_lossy().into_owned(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "workspace 外绝对路径写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(
            err.contains("within the workspace root"),
            "应因越界被拒，实际: {err}"
        );
        assert!(!outside.exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn successful_write_returns_persisted_change_set() {
        let (base, ws) = unique_workspace();
        let journal = base.join("journal");
        let result = write_workspace_file_blocking_with_journal(
            "new.txt".to_string(),
            "content".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            None,
            root_arg(&ws),
            None,
            None,
            None,
            Some((
                journal.clone(),
                WorkspaceChangeContext {
                    change_id: "write-change".to_string(),
                    session_id: "session".to_string(),
                    run_id: "run".to_string(),
                    tool_call_id: "call".to_string(),
                },
            )),
            "write-change".to_string(),
        )
        .expect("write journaled file");

        assert_eq!(
            result.change_set.as_ref().map(|change| change.id.as_str()),
            Some("write-change")
        );
        assert!(journal.join("write-change.json").is_file());
        let _ = fs::remove_dir_all(&base);
    }

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

    #[test]
    fn automatic_index_compaction_keeps_latest_records_only() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".webAgent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let target = index_root.join("runs.jsonl");
        let filler = "x".repeat(700);
        let mut text = String::new();
        for status in 0..220 {
            text.push_str(
                &serde_json::json!({
                    "conversationId": "conversation",
                    "runId": "run",
                    "status": status,
                    "summary": filler,
                })
                .to_string(),
            );
            text.push('\n');
        }
        assert!(text.len() as u64 > INDEX_COMPACT_MIN_BYTES);
        fs::write(&target, text).expect("write oversized index");

        maybe_compact_subagent_index(&target).expect("compact index");
        let records: Vec<serde_json::Value> = fs::read_to_string(&target)
            .expect("read compacted index")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid record"))
            .collect();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["status"], 219);
        assert!(index_root.join(".runs.compact-at").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn index_compaction_uses_the_documented_keys() {
        let agents = [
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-02", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "completed"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_agents = compact_subagent_index("agents", &agents).expect("agents compact");
        let agent_records: Vec<serde_json::Value> = compacted_agents
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid agent record"))
            .collect();
        assert_eq!(agent_records.len(), 2);
        assert_eq!(agent_records[1]["path"], "root-01");
        assert_eq!(agent_records[1]["status"], "completed");

        let skills = [
            serde_json::json!({"skillId": "s1", "summary": "old"}),
            serde_json::json!({"skillId": "s2", "summary": "other"}),
            serde_json::json!({"skillId": "s1", "summary": "new"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_skills = compact_subagent_index("skills", &skills).expect("skills compact");
        let skill_records: Vec<serde_json::Value> = compacted_skills
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid skill record"))
            .collect();
        assert_eq!(skill_records.len(), 2);
        assert_eq!(skill_records[1]["skillId"], "s1");
        assert_eq!(skill_records[1]["summary"], "new");
    }

    #[test]
    fn compaction_failure_preserves_index_and_events_are_never_compacted() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".webAgent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let index = index_root.join("skills.jsonl");
        let malformed = format!("{{bad}}\n{}", " ".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&index, &malformed).expect("write malformed index");
        let error = maybe_compact_subagent_index(&index).expect_err("malformed index must fail");
        assert!(error.contains("invalid JSON"));
        assert_eq!(
            fs::read_to_string(&index).expect("read preserved index"),
            malformed
        );

        let events = ws.join(".webAgent-archive/conversations/c/runs/r/events.jsonl");
        fs::create_dir_all(events.parent().expect("events parent")).expect("create events root");
        let event_text = format!("event\n{}", "x".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&events, &event_text).expect("write events");
        maybe_compact_subagent_index(&events).expect("events bypass compaction");
        assert_eq!(fs::read_to_string(events).expect("read events"), event_text);
        let _ = fs::remove_dir_all(&base);
    }
}
