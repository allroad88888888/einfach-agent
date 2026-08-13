//! 变更集条目文件的命名、读写与状态更新。

use super::types::{ChangeStatus, WorkspaceChangeSet};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

pub(super) fn update_status(
    directory: &Path,
    change_id: &str,
    status: ChangeStatus,
) -> Result<(), String> {
    let read_started_at = Instant::now();
    let mut entry = read_entry(directory, change_id)?;
    log::info!(
        target: "web_agent::perf",
        "workspace_journal.phase operation_id={} phase=status_read phase_ms={:.1}",
        change_id,
        read_started_at.elapsed().as_secs_f64() * 1000.0,
    );
    entry.status = status;
    write_entry(directory, &entry)
}

pub(super) fn read_entry(directory: &Path, change_id: &str) -> Result<WorkspaceChangeSet, String> {
    let path = entry_path(directory, change_id);
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read change set `{change_id}`: {err}"))?;
    serde_json::from_str(&content).map_err(|err| format!("invalid change set `{change_id}`: {err}"))
}

pub(super) fn write_entry(directory: &Path, entry: &WorkspaceChangeSet) -> Result<(), String> {
    let directory_started_at = Instant::now();
    fs::create_dir_all(directory)
        .map_err(|err| format!("failed to create workspace change journal: {err}"))?;
    let directory_ms = directory_started_at.elapsed().as_secs_f64() * 1000.0;
    let path = entry_path(directory, &entry.id);
    let temporary = directory.join(format!(".{}.tmp", entry.id));
    let serialize_started_at = Instant::now();
    let bytes = serde_json::to_vec(entry)
        .map_err(|err| format!("failed to encode workspace change: {err}"))?;
    let serialize_ms = serialize_started_at.elapsed().as_secs_f64() * 1000.0;
    let journal_bytes = bytes.len();
    let write_started_at = Instant::now();
    fs::write(&temporary, bytes)
        .map_err(|err| format!("failed to write workspace change: {err}"))?;
    let file_write_ms = write_started_at.elapsed().as_secs_f64() * 1000.0;
    let rename_started_at = Instant::now();
    fs::rename(&temporary, &path)
        .map_err(|err| format!("failed to commit workspace change: {err}"))?;
    log::info!(
        target: "web_agent::perf",
        "workspace_journal.write operation_id={} status={:?} file_count={} journal_bytes={} directory_ms={:.1} serialize_ms={:.1} file_write_ms={:.1} rename_ms={:.1}",
        entry.id,
        entry.status,
        entry.files.len(),
        journal_bytes,
        directory_ms,
        serialize_ms,
        file_write_ms,
        rename_started_at.elapsed().as_secs_f64() * 1000.0,
    );
    Ok(())
}

pub(super) fn entry_path(directory: &Path, change_id: &str) -> PathBuf {
    directory.join(format!("{change_id}.json"))
}

pub(super) fn payload_path(directory: &Path, change_id: &str) -> PathBuf {
    directory.join(format!("{change_id}.payload"))
}
pub(super) fn validate_change_id(change_id: &str) -> Result<(), String> {
    if change_id.is_empty()
        || !change_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid workspace change id".to_string());
    }
    Ok(())
}
