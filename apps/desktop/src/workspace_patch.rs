//! workspace 批量补丁的模块装配与 Tauri 命令入口。

#[path = "workspace_patch_commit.rs"]
mod commit;
#[path = "workspace_patch_fs.rs"]
mod fs_ops;
#[path = "workspace_patch_guard.rs"]
mod guard;
#[path = "workspace_patch_limits.rs"]
mod limits;
#[path = "workspace_patch_operation.rs"]
mod operation;
#[path = "workspace_patch_path.rs"]
mod path;
#[path = "workspace_patch_perf.rs"]
mod perf;
#[path = "workspace_patch_pipeline.rs"]
mod pipeline;
#[path = "workspace_patch_result.rs"]
mod result;
#[path = "workspace_patch_stage.rs"]
mod stage;

#[cfg(test)]
#[path = "workspace_patch_test_support.rs"]
mod test_support;

pub use self::operation::PatchOperation;
pub use self::result::WorkspacePatchResult;

use self::perf::PERF_LOG_TARGET;
use self::pipeline::apply_workspace_patch_blocking_with_journal;
use crate::workspace_change_journal::{journal_dir, WorkspaceChangeContext};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[tauri::command(rename_all = "snake_case")]
pub async fn apply_workspace_patch(
    app: tauri::AppHandle,
    operations: Vec<PatchOperation>,
    dry_run: Option<bool>,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
    diagnostic_operation_id: Option<String>,
) -> Result<WorkspacePatchResult, String> {
    let operation_id = diagnostic_operation_id
        .or_else(|| {
            change_context
                .as_ref()
                .map(|context| context.change_id.clone())
        })
        .unwrap_or_else(|| {
            format!(
                "workspace-patch-{}",
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
        "workspace_patch.host operation_id={} phase=journal_resolve phase_ms={:.1}",
        operation_id,
        journal_resolve_started_at.elapsed().as_secs_f64() * 1000.0,
    );
    tauri::async_runtime::spawn_blocking(move || {
        apply_workspace_patch_blocking_with_journal(
            operations,
            dry_run.unwrap_or(false),
            workspace_root,
            journal,
            operation_id,
        )
    })
    .await
    .map_err(|err| format!("workspace patch worker failed: {err}"))?
}
