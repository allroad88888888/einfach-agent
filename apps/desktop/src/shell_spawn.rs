//! shell 子进程的启动：拼装命令行、注入 env，并按平台配置进程组。

use super::types::ShellSpec;
use std::{
    collections::HashMap,
    path::Path,
    process::{Child, Command, Stdio},
};

pub(super) fn spawn_shell_command(
    shell: &ShellSpec,
    command: &str,
    cwd: &Path,
    child_env: Option<HashMap<String, String>>,
) -> Result<Child, String> {
    let mut child_command = Command::new(shell.program);
    child_command
        .args(shell.args)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(child_env) = child_env {
        child_command.envs(child_env);
    }

    configure_child_process(&mut child_command);

    child_command
        .spawn()
        .map_err(|err| format!("failed to spawn shell `{}`: {err}", shell.display))
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_child_process(_command: &mut Command) {}
