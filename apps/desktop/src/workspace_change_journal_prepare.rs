//! 变更集条目的登记生命周期：预留、标记已应用、丢弃。

use super::store::{entry_path, payload_path, update_status, validate_change_id, write_entry};
use super::types::{
    ChangeFileInput, ChangeStatus, ChangedFile, FileSnapshot, MovedPath, RelocatedPath,
    TrackedPath, WorkspaceChangeContext, WorkspaceChangeSet, WorkspaceChangeSummary,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

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
