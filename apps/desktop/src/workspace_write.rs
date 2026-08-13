//! workspace 文件写入的模块装配与 Tauri 命令入口。

#[path = "workspace_write_base64.rs"]
mod base64;
#[path = "workspace_write_before.rs"]
mod before;
#[path = "workspace_write_compaction.rs"]
mod compaction;
#[path = "workspace_write_fs_ops.rs"]
mod fs_ops;
#[path = "workspace_write_guard.rs"]
mod guard;
#[path = "workspace_write_limits.rs"]
mod limits;
#[path = "workspace_write_lock.rs"]
mod lock;
#[path = "workspace_write_options.rs"]
mod options;
#[path = "workspace_write_perf.rs"]
mod perf;
#[path = "workspace_write_pipeline.rs"]
mod pipeline;
#[path = "workspace_write_result.rs"]
mod result;
#[path = "workspace_write_target_path.rs"]
mod target_path;
#[cfg(test)]
#[path = "workspace_write_test_support.rs"]
mod test_support;

pub use self::result::WorkspaceWriteResult;

use self::perf::PERF_LOG_TARGET;
use self::pipeline::write_workspace_file_blocking_with_journal;
use crate::workspace_change_journal::{journal_dir, WorkspaceChangeContext};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
