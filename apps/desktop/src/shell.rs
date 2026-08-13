//! shell 命令执行的模块装配与 Tauri 命令入口。

#[path = "shell_drain.rs"]
mod drain;
#[path = "shell_output.rs"]
mod output;
#[path = "shell_pipeline.rs"]
mod pipeline;
#[path = "shell_platform.rs"]
mod platform;
#[path = "shell_spawn.rs"]
mod spawn;
#[path = "shell_types.rs"]
mod types;
#[path = "shell_wait.rs"]
mod wait;

#[cfg(test)]
#[path = "shell_test_support.rs"]
mod test_support;

pub use self::types::ShellCommandResult;

use self::pipeline::run_shell_command_blocking;
use std::collections::HashMap;

#[tauri::command(rename_all = "snake_case")]
pub async fn run_shell_command(
    platform: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
    env: Option<HashMap<String, String>>,
) -> Result<ShellCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_shell_command_blocking(platform, command, cwd, timeout_ms, max_output_chars, env)
    })
    .await
    .map_err(|err| format!("shell command worker failed: {err}"))?
}
