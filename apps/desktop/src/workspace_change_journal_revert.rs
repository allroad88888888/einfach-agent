//! 单个变更集的回滚：冲突预检、逐项还原与失败补偿。

use super::path_ops::{move_path, path_fingerprint};
use super::snapshot::{read_snapshot, resolve_recorded_path, write_snapshot};
use super::store::{payload_path, read_entry, validate_change_id, write_entry};
use super::types::{
    error_result, ChangeStatus, ChangedFile, WorkspaceChangeConflict, WorkspaceRevertResult,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn revert_change_set_blocking(
    directory: &Path,
    change_id: &str,
    dry_run: bool,
    workspace_root: &Path,
) -> Result<WorkspaceRevertResult, String> {
    validate_change_id(change_id)?;
    let mut entry = read_entry(directory, change_id)?;
    if entry.status == ChangeStatus::Reverted {
        return Ok(WorkspaceRevertResult {
            ok: true,
            status: "already_reverted".to_string(),
            restored_files: Vec::new(),
            conflicts: Vec::new(),
            error: None,
            reverted_change_set_ids: Vec::new(),
        });
    }

    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("failed to resolve workspace root: {err}"))?;
    if entry.workspace_root != canonical_root.to_string_lossy().as_ref() {
        return Ok(error_result(
            "workspace_mismatch",
            "change set belongs to a different workspace",
        ));
    }

    let mut resolved = Vec::with_capacity(entry.files.len());
    let mut moved = Vec::with_capacity(entry.moved_paths.len());
    let mut created = Vec::with_capacity(entry.created_paths.len());
    let mut relocated = Vec::with_capacity(entry.relocated_paths.len());
    let mut conflicts = Vec::new();
    for file in &entry.files {
        let path = resolve_recorded_path(&canonical_root, &file.path)?;
        let current = read_snapshot(&path)?;
        if !current.same_state(&file.after) {
            conflicts.push(WorkspaceChangeConflict {
                path: file.path.clone(),
                reason: "file changed after the original tool call".to_string(),
            });
        }
        resolved.push(path);
    }
    for moved_path in &entry.moved_paths {
        let path = resolve_recorded_path(&canonical_root, &moved_path.path)?;
        if fs::symlink_metadata(&path).is_ok() {
            conflicts.push(WorkspaceChangeConflict {
                path: moved_path.path.clone(),
                reason: "deleted path was recreated after the original tool call".to_string(),
            });
        }
        moved.push(path);
    }
    for item in &entry.created_paths {
        let path = resolve_recorded_path(&canonical_root, &item.path)?;
        if path_fingerprint(&path).as_deref() != Ok(item.fingerprint.as_str()) {
            conflicts.push(WorkspaceChangeConflict {
                path: item.path.clone(),
                reason: "copied path changed after the original tool call".to_string(),
            });
        }
        created.push(path);
    }
    for item in &entry.relocated_paths {
        let source = resolve_recorded_path(&canonical_root, &item.source)?;
        let destination = resolve_recorded_path(&canonical_root, &item.destination)?;
        if fs::symlink_metadata(&source).is_ok()
            || path_fingerprint(&destination).as_deref() != Ok(item.fingerprint.as_str())
        {
            conflicts.push(WorkspaceChangeConflict {
                path: item.destination.clone(),
                reason: "moved path changed after the original tool call".to_string(),
            });
        }
        relocated.push((source, destination));
    }
    if !entry.moved_paths.is_empty()
        && fs::symlink_metadata(payload_path(directory, change_id)).is_err()
    {
        return Ok(error_result(
            "missing_payload",
            "recoverable delete payload is missing",
        ));
    }
    if !conflicts.is_empty() {
        return Ok(WorkspaceRevertResult {
            ok: false,
            status: "conflict".to_string(),
            restored_files: Vec::new(),
            conflicts,
            error: None,
            reverted_change_set_ids: Vec::new(),
        });
    }
    if dry_run {
        let mut restored_files: Vec<String> =
            entry.files.iter().map(|file| file.path.clone()).collect();
        restored_files.extend(entry.moved_paths.iter().map(|item| item.path.clone()));
        restored_files.extend(entry.created_paths.iter().map(|item| item.path.clone()));
        restored_files.extend(entry.relocated_paths.iter().map(|item| item.source.clone()));
        return Ok(WorkspaceRevertResult {
            ok: true,
            status: "ready".to_string(),
            restored_files,
            conflicts: Vec::new(),
            error: None,
            reverted_change_set_ids: Vec::new(),
        });
    }

    let mut restored_indexes = Vec::new();
    for (index, (file, path)) in entry.files.iter().zip(resolved.iter()).enumerate() {
        let current = read_snapshot(path)?;
        if !current.same_state(&file.after) {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            return Ok(error_result(
                "conflict",
                format!("file changed while reverting: {}", file.path),
            ));
        }
        if let Err(error) = write_snapshot(&canonical_root, path, &file.before) {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            return Ok(error_result("failed", error));
        }
        restored_indexes.push(index);
    }

    let payload = payload_path(directory, change_id);
    let mut restored_moved_indexes = Vec::new();
    for (index, path) in moved.iter().enumerate() {
        if fs::symlink_metadata(path).is_ok() {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            compensate_moved(&payload, &moved, &restored_moved_indexes);
            return Ok(error_result(
                "conflict",
                format!(
                    "deleted path was recreated while reverting: {}",
                    entry.moved_paths[index].path
                ),
            ));
        }
        if let Err(error) = move_path(&payload, path) {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            compensate_moved(&payload, &moved, &restored_moved_indexes);
            return Ok(error_result("failed", error));
        }
        restored_moved_indexes.push(index);
    }

    let mut reverted_created: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (index, path) in created.iter().enumerate() {
        let item_payload = directory.join(format!("{change_id}.created-{index}.payload"));
        if let Err(error) = move_path(path, &item_payload) {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            compensate_moved(&payload, &moved, &restored_moved_indexes);
            for (payload, path) in reverted_created.iter().rev() {
                let _ = move_path(payload, path);
            }
            return Ok(error_result("failed", error));
        }
        reverted_created.push((item_payload, path.clone()));
    }
    let mut reverted_relocated: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (source, destination) in &relocated {
        if let Err(error) = move_path(destination, source) {
            compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
            compensate_moved(&payload, &moved, &restored_moved_indexes);
            for (payload, path) in reverted_created.iter().rev() {
                let _ = move_path(payload, path);
            }
            for (source, destination) in reverted_relocated.iter().rev() {
                let _ = move_path(source, destination);
            }
            return Ok(error_result("failed", error));
        }
        reverted_relocated.push((source.clone(), destination.clone()));
    }

    entry.status = ChangeStatus::Reverted;
    if let Err(error) = write_entry(directory, &entry) {
        compensate(&canonical_root, &entry.files, &resolved, &restored_indexes);
        compensate_moved(&payload, &moved, &restored_moved_indexes);
        for (payload, path) in reverted_created.iter().rev() {
            let _ = move_path(payload, path);
        }
        for (source, destination) in reverted_relocated.iter().rev() {
            let _ = move_path(source, destination);
        }
        return Ok(error_result("failed", error));
    }

    let mut restored_files: Vec<String> =
        entry.files.iter().map(|file| file.path.clone()).collect();
    restored_files.extend(entry.moved_paths.iter().map(|item| item.path.clone()));
    restored_files.extend(entry.created_paths.iter().map(|item| item.path.clone()));
    restored_files.extend(entry.relocated_paths.iter().map(|item| item.source.clone()));
    Ok(WorkspaceRevertResult {
        ok: true,
        status: "reverted".to_string(),
        restored_files,
        conflicts: Vec::new(),
        error: None,
        reverted_change_set_ids: vec![change_id.to_string()],
    })
}

fn compensate_moved(payload: &Path, paths: &[PathBuf], restored_indexes: &[usize]) {
    for index in restored_indexes.iter().rev() {
        let _ = move_path(&paths[*index], payload);
    }
}

fn compensate(root: &Path, files: &[ChangedFile], paths: &[PathBuf], restored_indexes: &[usize]) {
    for index in restored_indexes.iter().rev() {
        let _ = write_snapshot(root, &paths[*index], &files[*index].after);
    }
}

#[cfg(test)]
#[path = "workspace_change_journal_revert_tests.rs"]
mod tests;
