//! workspace git 差异查询的模块装配与 Tauri 命令入口。

#[path = "workspace_git_args.rs"]
mod args;
#[path = "workspace_git_exec.rs"]
mod exec;
#[path = "workspace_git_path.rs"]
mod path;
#[path = "workspace_git_pipeline.rs"]
mod pipeline;
#[path = "workspace_git_types.rs"]
mod types;

#[cfg(test)]
#[path = "workspace_git_test_support.rs"]
mod test_support;

pub use self::types::WorkspaceDiffResult;

use self::pipeline::get_workspace_diff_blocking;

#[tauri::command(rename_all = "snake_case")]
pub async fn get_workspace_diff(
    paths: Option<Vec<String>>,
    staged: Option<bool>,
    base: Option<String>,
    max_diff_chars: Option<usize>,
    include_stat: Option<bool>,
    workspace_root: Option<String>,
) -> Result<WorkspaceDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_workspace_diff_blocking(
            paths,
            staged,
            base,
            max_diff_chars,
            include_stat,
            workspace_root,
        )
    })
    .await
    .map_err(|err| format!("workspace git worker failed: {err}"))?
}
