//! 多个变更集的批量回滚：整批预演、逆序执行与失败重放。

use super::path_ops::{move_path, path_fingerprint};
use super::revert::revert_change_set_blocking;
use super::snapshot::{read_snapshot, resolve_recorded_path, write_snapshot};
use super::store::{payload_path, read_entry, validate_change_id, write_entry};
use super::types::{
    error_result, ChangeStatus, FileSnapshot, WorkspaceChangeConflict, WorkspaceRevertResult,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

pub(super) fn revert_change_sets_blocking(
    directory: &Path,
    change_ids: &[String],
    dry_run: bool,
    workspace_root: &Path,
) -> Result<WorkspaceRevertResult, String> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("failed to resolve workspace root: {err}"))?;
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(change_ids.len());
    for id in change_ids {
        validate_change_id(id)?;
        if !seen.insert(id.clone()) {
            return Ok(error_result(
                "failed",
                format!("duplicate change set id: {id}"),
            ));
        }
        let entry = read_entry(directory, id)?;
        if entry.workspace_root != canonical_root.to_string_lossy().as_ref() {
            return Ok(error_result(
                "workspace_mismatch",
                format!("change set {id} belongs to a different workspace"),
            ));
        }
        entries.push(entry);
    }
    // Journal creation order is authoritative. Callers still send execution order, but this
    // protects batches assembled from parallel child agents whose results may be grouped by child.
    entries.sort_by_key(|entry| entry.created_at);

    // Simulate the whole rollback before touching disk. This is important for consecutive
    // changes to one file: an older entry only matches after the newer entry is simulated.
    let moved_paths: HashSet<&str> = entries
        .iter()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
        .flat_map(|entry| entry.moved_paths.iter().map(|item| item.path.as_str()))
        .collect();
    let structured_paths: Vec<&str> = entries
        .iter()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
        .flat_map(|entry| {
            entry
                .created_paths
                .iter()
                .map(|item| item.path.as_str())
                .chain(
                    entry
                        .relocated_paths
                        .iter()
                        .flat_map(|item| [item.source.as_str(), item.destination.as_str()]),
                )
        })
        .collect();
    let structured_unique: HashSet<&str> = structured_paths.iter().copied().collect();
    if entries
        .iter()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
        .flat_map(|entry| &entry.files)
        .any(|file| {
            moved_paths.contains(file.path.as_str())
                || structured_unique.contains(file.path.as_str())
        })
        || moved_paths.len()
            != entries
                .iter()
                .filter(|entry| entry.status != ChangeStatus::Reverted)
                .map(|entry| entry.moved_paths.len())
                .sum::<usize>()
        || structured_unique.len() != structured_paths.len()
    {
        return Ok(error_result(
            "conflict",
            "batch rollback cannot safely combine overlapping path-delete and file changes",
        ));
    }

    let mut simulated: HashMap<String, FileSnapshot> = HashMap::new();
    let mut conflicts = Vec::new();
    for entry in entries
        .iter()
        .rev()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
    {
        for file in &entry.files {
            let current = if let Some(snapshot) = simulated.get(&file.path) {
                snapshot.clone()
            } else {
                read_snapshot(&resolve_recorded_path(&canonical_root, &file.path)?)?
            };
            if !current.same_state(&file.after) {
                conflicts.push(WorkspaceChangeConflict {
                    path: file.path.clone(),
                    reason: format!("state does not match change set {}", entry.id),
                });
            }
            simulated.insert(file.path.clone(), file.before.clone());
        }
        for moved in &entry.moved_paths {
            let path = resolve_recorded_path(&canonical_root, &moved.path)?;
            if fs::symlink_metadata(&path).is_ok() {
                conflicts.push(WorkspaceChangeConflict {
                    path: moved.path.clone(),
                    reason: format!("deleted path was recreated after change set {}", entry.id),
                });
            }
            if fs::symlink_metadata(payload_path(directory, &entry.id)).is_err() {
                return Ok(error_result(
                    "missing_payload",
                    format!("recoverable delete payload is missing for {}", entry.id),
                ));
            }
        }
        for created in &entry.created_paths {
            let path = resolve_recorded_path(&canonical_root, &created.path)?;
            if path_fingerprint(&path).as_deref() != Ok(created.fingerprint.as_str()) {
                conflicts.push(WorkspaceChangeConflict {
                    path: created.path.clone(),
                    reason: format!("copied path changed after change set {}", entry.id),
                });
            }
        }
        for relocated in &entry.relocated_paths {
            let source = resolve_recorded_path(&canonical_root, &relocated.source)?;
            let destination = resolve_recorded_path(&canonical_root, &relocated.destination)?;
            if fs::symlink_metadata(&source).is_ok()
                || path_fingerprint(&destination).as_deref() != Ok(relocated.fingerprint.as_str())
            {
                conflicts.push(WorkspaceChangeConflict {
                    path: relocated.destination.clone(),
                    reason: format!("moved path changed after change set {}", entry.id),
                });
            }
        }
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

    let restored_files = entries
        .iter()
        .rev()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
        .flat_map(|entry| {
            entry
                .files
                .iter()
                .map(|item| item.path.clone())
                .chain(entry.moved_paths.iter().map(|item| item.path.clone()))
                .chain(entry.created_paths.iter().map(|item| item.path.clone()))
                .chain(entry.relocated_paths.iter().map(|item| item.source.clone()))
        })
        .collect();
    if dry_run {
        return Ok(WorkspaceRevertResult {
            ok: true,
            status: "batch_ready".to_string(),
            restored_files,
            conflicts: Vec::new(),
            error: None,
            reverted_change_set_ids: Vec::new(),
        });
    }

    let mut reverted: Vec<String> = Vec::new();
    for entry in entries
        .iter()
        .rev()
        .filter(|entry| entry.status != ChangeStatus::Reverted)
    {
        let result = revert_change_set_blocking(directory, &entry.id, false, &canonical_root)?;
        if !result.ok {
            for id in reverted.iter().rev() {
                let _ = reapply_change_set_blocking(directory, id, &canonical_root);
            }
            return Ok(error_result(
                "failed",
                format!(
                    "batch rollback stopped at {}: {}",
                    entry.id,
                    result.error.unwrap_or(result.status)
                ),
            ));
        }
        reverted.push(entry.id.clone());
    }
    Ok(WorkspaceRevertResult {
        ok: true,
        status: "batch_reverted".to_string(),
        restored_files,
        conflicts: Vec::new(),
        error: None,
        reverted_change_set_ids: reverted,
    })
}

fn reapply_change_set_blocking(
    directory: &Path,
    change_id: &str,
    workspace_root: &Path,
) -> Result<(), String> {
    let mut entry = read_entry(directory, change_id)?;
    for file in &entry.files {
        let path = resolve_recorded_path(workspace_root, &file.path)?;
        let current = read_snapshot(&path)?;
        if !current.same_state(&file.before) {
            return Err(format!("cannot compensate changed file {}", file.path));
        }
        write_snapshot(workspace_root, &path, &file.after)?;
    }
    let payload = payload_path(directory, change_id);
    for moved in &entry.moved_paths {
        let path = resolve_recorded_path(workspace_root, &moved.path)?;
        move_path(&path, &payload)?;
    }
    for (index, created) in entry.created_paths.iter().enumerate() {
        let payload = directory.join(format!("{change_id}.created-{index}.payload"));
        let path = resolve_recorded_path(workspace_root, &created.path)?;
        move_path(&payload, &path)?;
    }
    for relocated in &entry.relocated_paths {
        let source = resolve_recorded_path(workspace_root, &relocated.source)?;
        let destination = resolve_recorded_path(workspace_root, &relocated.destination)?;
        move_path(&source, &destination)?;
    }
    entry.status = ChangeStatus::Applied;
    write_entry(directory, &entry)
}

#[cfg(test)]
#[path = "workspace_change_journal_batch_tests.rs"]
mod tests;
