//! workspace 变更日志的模块装配与回滚命令入口。

#[path = "workspace_change_journal_batch.rs"]
mod batch;
#[path = "workspace_change_journal_path_ops.rs"]
mod path_ops;
#[path = "workspace_change_journal_prepare.rs"]
mod prepare;
#[path = "workspace_change_journal_revert.rs"]
mod revert;
#[path = "workspace_change_journal_snapshot.rs"]
mod snapshot;
#[path = "workspace_change_journal_store.rs"]
mod store;
#[path = "workspace_change_journal_types.rs"]
mod types;

#[cfg(test)]
#[path = "workspace_change_journal_test_support.rs"]
mod test_support;

pub(crate) use self::path_ops::{copy_path, move_path, path_fingerprint};
pub use self::prepare::{
    change_payload_path, discard_prepared_change, mark_change_applied, prepare_change_set,
    prepare_created_path_change, prepare_deleted_path_change, prepare_relocated_path_change,
};
pub(crate) use self::revert::revert_change_set_blocking;
pub use self::types::{
    ChangeFileInput, WorkspaceChangeContext, WorkspaceChangeSummary, WorkspaceRevertResult,
};

use self::batch::revert_change_sets_blocking;
use crate::workspace_common::resolve_workspace_root;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const JOURNAL_DIR: &str = "workspace-changes";

pub fn journal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(JOURNAL_DIR))
        .map_err(|err| format!("failed to resolve app data directory: {err}"))
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
