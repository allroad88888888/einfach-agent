//! shell 命令执行的阻塞式主流程：校验平台、起子进程、等待/超时、收尾输出。

use super::drain::drain_output_readers;
use super::output::{spawn_output_reader, take_captured};
use super::platform::{current_platform, parse_platform, resolve_cwd, resolve_shell};
use super::spawn::spawn_shell_command;
use super::types::{
    ShellCommandResult, OutputSink, DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS,
    MAX_OUTPUT_CHARS, MAX_TIMEOUT_MS,
};
use super::wait::wait_for_child;
use std::{collections::HashMap, time::Instant};

pub(super) fn run_shell_command_blocking(
    platform: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
    child_env: Option<HashMap<String, String>>,
) -> Result<ShellCommandResult, String> {
    let start = Instant::now();
    let requested_platform = match parse_platform(&platform) {
        Ok(platform) => platform,
        Err(err) => {
            return Ok(failed_result(
                &platform,
                "unavailable".to_string(),
                command,
                cwd.unwrap_or_default(),
                err,
                start,
            ));
        }
    };
    let current_platform = current_platform();
    if requested_platform != current_platform {
        return Ok(failed_result(
            requested_platform,
            "unavailable".to_string(),
            command,
            cwd.unwrap_or_default(),
            format!(
                "platform mismatch: requested `{requested_platform}`, current `{current_platform}`"
            ),
            start,
        ));
    }

    let shell = match resolve_shell(requested_platform) {
        Ok(shell) => shell,
        Err(err) => {
            return Ok(failed_result(
                requested_platform,
                "unavailable".to_string(),
                command,
                cwd.unwrap_or_default(),
                err,
                start,
            ));
        }
    };
    let cwd_input = cwd.unwrap_or_default();
    let cwd_path = match resolve_cwd(if cwd_input.is_empty() {
        None
    } else {
        Some(cwd_input.clone())
    }) {
        Ok(path) => path,
        Err(err) => {
            return Ok(failed_result(
                requested_platform,
                shell.display,
                command,
                cwd_input,
                err,
                start,
            ));
        }
    };
    let cwd_display = cwd_path.to_string_lossy().to_string();
    let timeout_ms = normalize_timeout_ms(timeout_ms);
    let max_output_chars = normalize_max_output_chars(max_output_chars);

    let mut child = match spawn_shell_command(&shell, &command, &cwd_path, child_env) {
        Ok(child) => child,
        Err(err) => {
            return Ok(failed_result(
                requested_platform,
                shell.display,
                command,
                cwd_display,
                err,
                start,
            ));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture child stderr".to_string())?;

    let stdout_sink = OutputSink::default();
    let stderr_sink = OutputSink::default();
    let stdout_handle = spawn_output_reader(stdout, max_output_chars, &stdout_sink);
    let stderr_handle = spawn_output_reader(stderr, max_output_chars, &stderr_sink);

    let (exit_code, timed_out) = wait_for_child(&mut child, timeout_ms)?;
    let background_processes_killed = drain_output_readers(
        &mut child,
        vec![(stdout_handle, "stdout"), (stderr_handle, "stderr")],
    )?;
    let duration_ms = millis_since(start);

    let stdout = take_captured(&stdout_sink);
    let stderr = take_captured(&stderr_sink);

    Ok(ShellCommandResult {
        platform: requested_platform.to_string(),
        shell: shell.display,
        command,
        cwd: cwd_display,
        exit_code,
        stdout: stdout.text,
        stderr: stderr.text,
        duration_ms,
        timed_out,
        truncated: stdout.truncated || stderr.truncated,
        background_processes_killed,
    })
}

fn failed_result(
    platform: &str,
    shell: String,
    command: String,
    cwd: String,
    stderr: String,
    start: Instant,
) -> ShellCommandResult {
    ShellCommandResult {
        platform: platform.to_string(),
        shell,
        command,
        cwd,
        exit_code: Some(1),
        stdout: String::new(),
        stderr,
        duration_ms: millis_since(start),
        timed_out: false,
        truncated: false,
        background_processes_killed: false,
    }
}

fn normalize_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    match timeout_ms {
        Some(value) if value > 0 => value.min(MAX_TIMEOUT_MS),
        _ => DEFAULT_TIMEOUT_MS,
    }
}

fn normalize_max_output_chars(max_output_chars: Option<usize>) -> usize {
    match max_output_chars {
        Some(value) if value > 0 => value.min(MAX_OUTPUT_CHARS),
        _ => DEFAULT_MAX_OUTPUT_CHARS,
    }
}

fn millis_since(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "shell_pipeline_tests.rs"]
mod tests;
