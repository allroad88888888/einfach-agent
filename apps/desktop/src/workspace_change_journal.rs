use crate::workspace_common::resolve_workspace_root;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const JOURNAL_DIR: &str = "workspace-changes";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeContext {
    pub change_id: String,
    pub session_id: String,
    pub run_id: String,
    pub tool_call_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeSummary {
    pub id: String,
    pub reversible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ChangeStatus {
    Prepared,
    Applied,
    Reverted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    exists: bool,
    hash: Option<String>,
    content: Option<String>,
}

impl FileSnapshot {
    fn from_content(content: Option<String>) -> Self {
        let hash = content.as_ref().map(|value| {
            let mut hasher = Sha256::new();
            hasher.update(value.as_bytes());
            format!("{:x}", hasher.finalize())
        });
        Self {
            exists: content.is_some(),
            hash,
            content,
        }
    }

    fn same_state(&self, other: &Self) -> bool {
        self.exists == other.exists && self.hash == other.hash
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    path: String,
    before: FileSnapshot,
    after: FileSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MovedPath {
    path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackedPath {
    path: String,
    fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelocatedPath {
    source: String,
    destination: String,
    fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeSet {
    id: String,
    session_id: String,
    run_id: String,
    tool_call_id: String,
    workspace_root: String,
    created_at: u128,
    status: ChangeStatus,
    #[serde(default)]
    files: Vec<ChangedFile>,
    #[serde(default)]
    moved_paths: Vec<MovedPath>,
    #[serde(default)]
    created_paths: Vec<TrackedPath>,
    #[serde(default)]
    relocated_paths: Vec<RelocatedPath>,
}

#[derive(Clone, Debug)]
pub struct ChangeFileInput {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeConflict {
    path: String,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRevertResult {
    pub ok: bool,
    pub status: String,
    pub restored_files: Vec<String>,
    pub conflicts: Vec<WorkspaceChangeConflict>,
    pub error: Option<String>,
    pub reverted_change_set_ids: Vec<String>,
}

pub fn journal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(JOURNAL_DIR))
        .map_err(|err| format!("failed to resolve app data directory: {err}"))
}

pub fn prepare_change_set(
    directory: &Path,
    context: WorkspaceChangeContext,
    workspace_root: &Path,
    files: Vec<ChangeFileInput>,
) -> Result<WorkspaceChangeSummary, String> {
    validate_change_id(&context.change_id)?;
    if files.is_empty() {
        return Err("cannot journal an empty workspace change".to_string());
    }
    if entry_path(directory, &context.change_id).exists() {
        return Err("workspace change id already exists".to_string());
    }

    let entry = WorkspaceChangeSet {
        id: context.change_id.clone(),
        session_id: context.session_id,
        run_id: context.run_id,
        tool_call_id: context.tool_call_id,
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        status: ChangeStatus::Prepared,
        files: files
            .into_iter()
            .map(|file| ChangedFile {
                path: file.path,
                before: FileSnapshot::from_content(file.before),
                after: FileSnapshot::from_content(file.after),
            })
            .collect(),
        moved_paths: Vec::new(),
        created_paths: Vec::new(),
        relocated_paths: Vec::new(),
    };
    write_entry(directory, &entry)?;
    Ok(WorkspaceChangeSummary {
        id: context.change_id,
        reversible: true,
    })
}

pub fn prepare_deleted_path_change(
    directory: &Path,
    context: WorkspaceChangeContext,
    workspace_root: &Path,
    path: String,
) -> Result<WorkspaceChangeSummary, String> {
    validate_change_id(&context.change_id)?;
    if entry_path(directory, &context.change_id).exists()
        || payload_path(directory, &context.change_id).exists()
    {
        return Err("workspace change id already exists".to_string());
    }
    let entry = WorkspaceChangeSet {
        id: context.change_id.clone(),
        session_id: context.session_id,
        run_id: context.run_id,
        tool_call_id: context.tool_call_id,
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        status: ChangeStatus::Prepared,
        files: Vec::new(),
        moved_paths: vec![MovedPath { path }],
        created_paths: Vec::new(),
        relocated_paths: Vec::new(),
    };
    write_entry(directory, &entry)?;
    Ok(WorkspaceChangeSummary {
        id: context.change_id,
        reversible: true,
    })
}

pub fn prepare_created_path_change(
    directory: &Path,
    context: WorkspaceChangeContext,
    workspace_root: &Path,
    path: String,
    fingerprint: String,
) -> Result<WorkspaceChangeSummary, String> {
    prepare_path_operation_change(
        directory,
        context,
        workspace_root,
        vec![TrackedPath { path, fingerprint }],
        Vec::new(),
    )
}

pub fn prepare_relocated_path_change(
    directory: &Path,
    context: WorkspaceChangeContext,
    workspace_root: &Path,
    source: String,
    destination: String,
    fingerprint: String,
) -> Result<WorkspaceChangeSummary, String> {
    prepare_path_operation_change(
        directory,
        context,
        workspace_root,
        Vec::new(),
        vec![RelocatedPath {
            source,
            destination,
            fingerprint,
        }],
    )
}

fn prepare_path_operation_change(
    directory: &Path,
    context: WorkspaceChangeContext,
    workspace_root: &Path,
    created_paths: Vec<TrackedPath>,
    relocated_paths: Vec<RelocatedPath>,
) -> Result<WorkspaceChangeSummary, String> {
    validate_change_id(&context.change_id)?;
    if entry_path(directory, &context.change_id).exists() {
        return Err("workspace change id already exists".to_string());
    }
    let entry = WorkspaceChangeSet {
        id: context.change_id.clone(),
        session_id: context.session_id,
        run_id: context.run_id,
        tool_call_id: context.tool_call_id,
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        status: ChangeStatus::Prepared,
        files: Vec::new(),
        moved_paths: Vec::new(),
        created_paths,
        relocated_paths,
    };
    write_entry(directory, &entry)?;
    Ok(WorkspaceChangeSummary {
        id: context.change_id,
        reversible: true,
    })
}

pub fn change_payload_path(directory: &Path, change_id: &str) -> Result<PathBuf, String> {
    validate_change_id(change_id)?;
    Ok(payload_path(directory, change_id))
}

pub fn mark_change_applied(directory: &Path, change_id: &str) -> Result<(), String> {
    update_status(directory, change_id, ChangeStatus::Applied)
}

pub fn discard_prepared_change(directory: &Path, change_id: &str) {
    let _ = fs::remove_file(entry_path(directory, change_id));
    let payload = payload_path(directory, change_id);
    if payload.is_dir() {
        let _ = fs::remove_dir_all(payload);
    } else {
        let _ = fs::remove_file(payload);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn revert_workspace_change(
    app: AppHandle,
    change_set_id: Option<String>,
    change_set_ids: Option<Vec<String>>,
    dry_run: Option<bool>,
    workspace_root: Option<String>,
) -> Result<WorkspaceRevertResult, String> {
    let directory = journal_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_workspace_root(workspace_root.as_deref())?;
        let ids = change_set_ids
            .filter(|ids| !ids.is_empty())
            .or_else(|| change_set_id.map(|id| vec![id]))
            .ok_or_else(|| "change_set_id or change_set_ids is required".to_string())?;
        if ids.len() == 1 {
            revert_change_set_blocking(&directory, &ids[0], dry_run.unwrap_or(false), &root)
        } else {
            revert_change_sets_blocking(&directory, &ids, dry_run.unwrap_or(false), &root)
        }
    })
    .await
    .map_err(|err| format!("workspace revert worker failed: {err}"))?
}

fn revert_change_sets_blocking(
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

fn write_snapshot(root: &Path, path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err("recorded path escaped workspace root".to_string());
    }
    match &snapshot.content {
        Some(content) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
                let canonical_parent = fs::canonicalize(parent)
                    .map_err(|err| format!("failed to resolve `{}`: {err}", parent.display()))?;
                if !canonical_parent.starts_with(root) {
                    return Err("recorded path escaped workspace root".to_string());
                }
            }
            fs::write(path, content)
                .map_err(|err| format!("failed to restore `{}`: {err}", path.display()))
        }
        None => {
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|err| format!("failed to remove `{}`: {err}", path.display()))?;
            }
            Ok(())
        }
    }
}

fn read_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    if !path.exists() {
        return Ok(FileSnapshot::from_content(None));
    }
    let bytes =
        fs::read(path).map_err(|err| format!("failed to read `{}`: {err}", path.display()))?;
    if bytes.contains(&0) {
        return Err(format!(
            "binary file is not reversible: `{}`",
            path.display()
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("non-UTF-8 file is not reversible: `{}`", path.display()))?;
    Ok(FileSnapshot::from_content(Some(content)))
}

fn resolve_recorded_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let raw = Path::new(relative);
    if raw.is_absolute()
        || raw.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("invalid path in workspace change journal".to_string());
    }
    let path = root.join(raw);
    if path.exists() {
        let canonical = fs::canonicalize(&path)
            .map_err(|err| format!("failed to resolve `{}`: {err}", path.display()))?;
        if !canonical.starts_with(root) {
            return Err("recorded path escaped workspace root".to_string());
        }
        Ok(canonical)
    } else {
        let mut ancestor = path.parent();
        while let Some(candidate) = ancestor {
            if candidate.exists() {
                let canonical = fs::canonicalize(candidate)
                    .map_err(|err| format!("failed to resolve `{}`: {err}", candidate.display()))?;
                if !canonical.starts_with(root) {
                    return Err("recorded path escaped workspace root".to_string());
                }
                break;
            }
            ancestor = candidate.parent();
        }
        Ok(path)
    }
}

pub(crate) fn copy_path(source: &Path, destination: &Path) -> Result<(), String> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(format!(
            "destination already exists: `{}`",
            destination.display()
        ));
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("failed to inspect `{}`: {err}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symbolic links are not supported by recoverable delete: `{}`",
            source.display()
        ));
    }
    if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|err| {
            format!(
                "failed to copy `{}` to `{}`: {err}",
                source.display(),
                destination.display()
            )
        })?;
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|err| format!("failed to preserve permissions: {err}"))?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "unsupported file type for recoverable delete: `{}`",
            source.display()
        ));
    }
    fs::create_dir(destination)
        .map_err(|err| format!("failed to create `{}`: {err}", destination.display()))?;
    let copy_result = (|| {
        for child in fs::read_dir(source)
            .map_err(|err| format!("failed to read `{}`: {err}", source.display()))?
        {
            let child = child.map_err(|err| format!("failed to read directory entry: {err}"))?;
            copy_path(&child.path(), &destination.join(child.file_name()))?;
        }
        fs::set_permissions(destination, metadata.permissions())
            .map_err(|err| format!("failed to preserve permissions: {err}"))
    })();
    if copy_result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    copy_result
}

pub(crate) fn path_fingerprint(path: &Path) -> Result<String, String> {
    fn hash_path(path: &Path, relative: &Path, hasher: &mut Sha256) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|err| format!("failed to inspect `{}`: {err}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "symbolic links are not supported: `{}`",
                path.display()
            ));
        }
        hasher.update(relative.to_string_lossy().as_bytes());
        if metadata.is_file() {
            hasher.update(b"file\0");
            hasher.update(
                fs::read(path)
                    .map_err(|err| format!("failed to read `{}`: {err}", path.display()))?,
            );
        } else if metadata.is_dir() {
            hasher.update(b"dir\0");
            let mut children = fs::read_dir(path)
                .map_err(|err| format!("failed to read `{}`: {err}", path.display()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("failed to read directory entry: {err}"))?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                hash_path(&child.path(), &relative.join(child.file_name()), hasher)?;
            }
        } else {
            return Err(format!("unsupported file type: `{}`", path.display()));
        }
        Ok(())
    }
    let mut hasher = Sha256::new();
    hash_path(path, Path::new("."), &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn move_path(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
    }
    if fs::rename(source, destination).is_ok() {
        return Ok(());
    }
    copy_path(source, destination)?;
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("failed to inspect `{}`: {err}", source.display()))?;
    let removed = if metadata.is_dir() {
        fs::remove_dir_all(source)
    } else {
        fs::remove_file(source)
    };
    if let Err(error) = removed {
        if destination.is_dir() {
            let _ = fs::remove_dir_all(destination);
        } else {
            let _ = fs::remove_file(destination);
        }
        return Err(format!(
            "failed to remove copied source `{}`: {error}",
            source.display()
        ));
    }
    Ok(())
}

fn update_status(directory: &Path, change_id: &str, status: ChangeStatus) -> Result<(), String> {
    let mut entry = read_entry(directory, change_id)?;
    entry.status = status;
    write_entry(directory, &entry)
}

fn read_entry(directory: &Path, change_id: &str) -> Result<WorkspaceChangeSet, String> {
    let path = entry_path(directory, change_id);
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read change set `{change_id}`: {err}"))?;
    serde_json::from_str(&content).map_err(|err| format!("invalid change set `{change_id}`: {err}"))
}

fn write_entry(directory: &Path, entry: &WorkspaceChangeSet) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|err| format!("failed to create workspace change journal: {err}"))?;
    let path = entry_path(directory, &entry.id);
    let temporary = directory.join(format!(".{}.tmp", entry.id));
    let bytes = serde_json::to_vec(entry)
        .map_err(|err| format!("failed to encode workspace change: {err}"))?;
    fs::write(&temporary, bytes)
        .map_err(|err| format!("failed to write workspace change: {err}"))?;
    fs::rename(&temporary, &path).map_err(|err| format!("failed to commit workspace change: {err}"))
}

fn entry_path(directory: &Path, change_id: &str) -> PathBuf {
    directory.join(format!("{change_id}.json"))
}

fn payload_path(directory: &Path, change_id: &str) -> PathBuf {
    directory.join(format!("{change_id}.payload"))
}
fn validate_change_id(change_id: &str) -> Result<(), String> {
    if change_id.is_empty()
        || !change_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid workspace change id".to_string());
    }
    Ok(())
}

fn error_result(status: &str, error: impl Into<String>) -> WorkspaceRevertResult {
    WorkspaceRevertResult {
        ok: false,
        status: status.to_string(),
        restored_files: Vec::new(),
        conflicts: Vec::new(),
        error: Some(error.into()),
        reverted_change_set_ids: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn roots() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "workspace_change_test_{}_{}",
            std::process::id(),
            seq
        ));
        let workspace = base.join("workspace");
        let journal = base.join("journal");
        fs::create_dir_all(&workspace).expect("create workspace");
        (
            fs::canonicalize(workspace).expect("canonical workspace"),
            journal,
        )
    }

    fn context(id: &str) -> WorkspaceChangeContext {
        WorkspaceChangeContext {
            change_id: id.to_string(),
            session_id: "session".to_string(),
            run_id: "run".to_string(),
            tool_call_id: "call".to_string(),
        }
    }

    #[test]
    fn reverts_create_and_is_idempotent() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("new.txt"), "new").expect("seed after");
        prepare_change_set(
            &journal,
            context("create-1"),
            &workspace,
            vec![ChangeFileInput {
                path: "new.txt".to_string(),
                before: None,
                after: Some("new".to_string()),
            }],
        )
        .expect("prepare");
        mark_change_applied(&journal, "create-1").expect("mark");

        let result =
            revert_change_set_blocking(&journal, "create-1", false, &workspace).expect("revert");
        assert!(result.ok);
        assert!(!workspace.join("new.txt").exists());
        let repeated =
            revert_change_set_blocking(&journal, "create-1", false, &workspace).expect("repeat");
        assert_eq!(repeated.status, "already_reverted");
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn refuses_drift_without_partial_revert() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("a.txt"), "after-a").expect("seed a");
        fs::write(workspace.join("b.txt"), "user-edit").expect("seed b");
        prepare_change_set(
            &journal,
            context("conflict-1"),
            &workspace,
            vec![
                ChangeFileInput {
                    path: "a.txt".to_string(),
                    before: Some("before-a".to_string()),
                    after: Some("after-a".to_string()),
                },
                ChangeFileInput {
                    path: "b.txt".to_string(),
                    before: Some("before-b".to_string()),
                    after: Some("after-b".to_string()),
                },
            ],
        )
        .expect("prepare");
        mark_change_applied(&journal, "conflict-1").expect("mark");

        let result =
            revert_change_set_blocking(&journal, "conflict-1", false, &workspace).expect("revert");
        assert!(!result.ok);
        assert_eq!(result.status, "conflict");
        assert_eq!(
            fs::read_to_string(workspace.join("a.txt")).unwrap(),
            "after-a"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("b.txt")).unwrap(),
            "user-edit"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn reverts_multiple_files_in_one_change_set() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("edited.txt"), "after-edit").expect("seed edited file");
        fs::write(workspace.join("created.txt"), "created").expect("seed created file");
        prepare_change_set(
            &journal,
            context("multi-file"),
            &workspace,
            vec![
                ChangeFileInput {
                    path: "edited.txt".to_string(),
                    before: Some("before-edit".to_string()),
                    after: Some("after-edit".to_string()),
                },
                ChangeFileInput {
                    path: "created.txt".to_string(),
                    before: None,
                    after: Some("created".to_string()),
                },
                ChangeFileInput {
                    path: "deleted.txt".to_string(),
                    before: Some("before-delete".to_string()),
                    after: None,
                },
            ],
        )
        .expect("prepare");
        mark_change_applied(&journal, "multi-file").expect("mark");

        let result =
            revert_change_set_blocking(&journal, "multi-file", false, &workspace).expect("revert");

        assert!(result.ok);
        assert_eq!(
            result.restored_files,
            vec!["edited.txt", "created.txt", "deleted.txt"]
        );
        assert_eq!(
            fs::read_to_string(workspace.join("edited.txt")).unwrap(),
            "before-edit"
        );
        assert!(!workspace.join("created.txt").exists());
        assert_eq!(
            fs::read_to_string(workspace.join("deleted.txt")).unwrap(),
            "before-delete"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn sequential_changes_revert_newest_first_then_older() {
        let (workspace, journal) = roots();
        let path = workspace.join("value.txt");
        fs::write(&path, "version-3").expect("seed latest version");

        prepare_change_set(
            &journal,
            context("change-1"),
            &workspace,
            vec![ChangeFileInput {
                path: "value.txt".to_string(),
                before: Some("version-1".to_string()),
                after: Some("version-2".to_string()),
            }],
        )
        .expect("prepare first");
        mark_change_applied(&journal, "change-1").expect("mark first");
        prepare_change_set(
            &journal,
            context("change-2"),
            &workspace,
            vec![ChangeFileInput {
                path: "value.txt".to_string(),
                before: Some("version-2".to_string()),
                after: Some("version-3".to_string()),
            }],
        )
        .expect("prepare second");
        mark_change_applied(&journal, "change-2").expect("mark second");

        let out_of_order =
            revert_change_set_blocking(&journal, "change-1", false, &workspace).expect("check old");
        assert!(!out_of_order.ok);
        assert_eq!(out_of_order.status, "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "version-3");

        let newest = revert_change_set_blocking(&journal, "change-2", false, &workspace)
            .expect("revert new");
        assert!(newest.ok);
        assert_eq!(fs::read_to_string(&path).unwrap(), "version-2");

        let older = revert_change_set_blocking(&journal, "change-1", false, &workspace)
            .expect("revert old");
        assert!(older.ok);
        assert_eq!(fs::read_to_string(&path).unwrap(), "version-1");
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn batch_reverts_multiple_change_sets_and_files_in_reverse_order() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("a.txt"), "a-3").expect("seed latest a");
        fs::write(workspace.join("b.txt"), "b-2").expect("seed latest b");

        prepare_change_set(
            &journal,
            context("batch-1"),
            &workspace,
            vec![
                ChangeFileInput {
                    path: "a.txt".to_string(),
                    before: Some("a-1".to_string()),
                    after: Some("a-2".to_string()),
                },
                ChangeFileInput {
                    path: "b.txt".to_string(),
                    before: Some("b-1".to_string()),
                    after: Some("b-2".to_string()),
                },
            ],
        )
        .expect("prepare first");
        mark_change_applied(&journal, "batch-1").expect("mark first");
        prepare_change_set(
            &journal,
            context("batch-2"),
            &workspace,
            vec![ChangeFileInput {
                path: "a.txt".to_string(),
                before: Some("a-2".to_string()),
                after: Some("a-3".to_string()),
            }],
        )
        .expect("prepare second");
        mark_change_applied(&journal, "batch-2").expect("mark second");

        let ids = vec!["batch-1".to_string(), "batch-2".to_string()];
        let result =
            revert_change_sets_blocking(&journal, &ids, false, &workspace).expect("batch revert");

        assert!(result.ok);
        assert_eq!(result.status, "batch_reverted");
        assert_eq!(result.reverted_change_set_ids, vec!["batch-2", "batch-1"]);
        assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a-1");
        assert_eq!(fs::read_to_string(workspace.join("b.txt")).unwrap(), "b-1");
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn batch_conflict_preflight_leaves_every_file_untouched() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("a.txt"), "a-2").expect("seed a");
        fs::write(workspace.join("b.txt"), "user-edit").expect("seed b");

        for (id, path, before, after) in [
            ("batch-safe", "a.txt", "a-1", "a-2"),
            ("batch-conflict", "b.txt", "b-1", "b-2"),
        ] {
            prepare_change_set(
                &journal,
                context(id),
                &workspace,
                vec![ChangeFileInput {
                    path: path.to_string(),
                    before: Some(before.to_string()),
                    after: Some(after.to_string()),
                }],
            )
            .expect("prepare");
            mark_change_applied(&journal, id).expect("mark");
        }

        let ids = vec!["batch-safe".to_string(), "batch-conflict".to_string()];
        let result =
            revert_change_sets_blocking(&journal, &ids, false, &workspace).expect("batch check");

        assert!(!result.ok);
        assert_eq!(result.status, "conflict");
        assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a-2");
        assert_eq!(
            fs::read_to_string(workspace.join("b.txt")).unwrap(),
            "user-edit"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }
}
