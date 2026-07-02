use serde::Serialize;
use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_MAX_OUTPUT_CHARS: usize = 20_000;
const MAX_OUTPUT_CHARS: usize = 100_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const WAIT_POLL_INTERVAL_MS: u64 = 10;

#[derive(Serialize)]
pub struct ShellCommandResult {
    platform: String,
    shell: String,
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    truncated: bool,
}

struct ShellSpec {
    program: &'static str,
    args: &'static [&'static str],
    display: String,
}

struct CapturedOutput {
    text: String,
    truncated: bool,
}

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

fn run_shell_command_blocking(
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

    let stdout_handle = thread::spawn(move || read_capped(stdout, max_output_chars));
    let stderr_handle = thread::spawn(move || read_capped(stderr, max_output_chars));

    let (exit_code, timed_out) = wait_for_child(&mut child, timeout_ms)?;
    let duration_ms = millis_since(start);

    let stdout = join_output_reader(stdout_handle, "stdout")?;
    let stderr = join_output_reader(stderr_handle, "stderr")?;

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

fn parse_platform(platform: &str) -> Result<&'static str, String> {
    match platform {
        "macos" => Ok("macos"),
        "linux" => Ok("linux"),
        "windows" => Ok("windows"),
        _ => Err(format!(
            "unsupported platform `{platform}`; expected `macos`, `linux`, or `windows`"
        )),
    }
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unsupported"
    }
}

fn resolve_shell(platform: &str) -> Result<ShellSpec, String> {
    match platform {
        "macos" => Ok(ShellSpec {
            program: "/bin/zsh",
            args: &["-lc"],
            display: "/bin/zsh -lc".to_string(),
        }),
        "linux" => {
            if Path::new("/bin/bash").exists() {
                Ok(ShellSpec {
                    program: "/bin/bash",
                    args: &["-lc"],
                    display: "/bin/bash -lc".to_string(),
                })
            } else if Path::new("/bin/sh").exists() {
                Ok(ShellSpec {
                    program: "/bin/sh",
                    args: &["-lc"],
                    display: "/bin/sh -lc".to_string(),
                })
            } else {
                Err("no supported Linux shell found: expected `/bin/bash` or `/bin/sh`".to_string())
            }
        }
        "windows" => Ok(ShellSpec {
            program: "powershell.exe",
            args: &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
            display: "powershell.exe -NoLogo -NoProfile -NonInteractive -Command".to_string(),
        }),
        _ => Err(format!("unsupported platform `{platform}`")),
    }
}

fn resolve_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let cwd_path = match cwd {
        Some(path) if path.trim().is_empty() => {
            return Err("cwd cannot be empty".to_string());
        }
        Some(path) => PathBuf::from(path),
        None => {
            env::current_dir().map_err(|err| format!("failed to read current directory: {err}"))?
        }
    };

    let metadata = fs::metadata(&cwd_path).map_err(|err| {
        format!(
            "cwd `{}` is not accessible: {err}",
            cwd_path.to_string_lossy()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "cwd `{}` is not a directory",
            cwd_path.to_string_lossy()
        ));
    }

    fs::canonicalize(&cwd_path).map_err(|err| {
        format!(
            "failed to resolve cwd `{}`: {err}",
            cwd_path.to_string_lossy()
        )
    })
}

fn spawn_shell_command(
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

fn wait_for_child(child: &mut Child, timeout_ms: u64) -> Result<(Option<i32>, bool), String> {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll child process: {err}"))?
        {
            return Ok((status.code(), false));
        }

        if start.elapsed() >= timeout {
            if let Err(kill_err) = kill_child(child) {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|err| format!("failed to poll child process after timeout: {err}"))?
                {
                    return Ok((status.code(), false));
                }

                return Err(format!(
                    "failed to kill timed out child process: {kill_err}"
                ));
            }

            let status = child
                .wait()
                .map_err(|err| format!("failed to wait for timed out child process: {err}"))?;
            return Ok((status.code(), true));
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS));
    }
}

fn read_capped<R: Read>(mut reader: R, max_chars: usize) -> io::Result<CapturedOutput> {
    let mut output = String::new();
    let mut chars_written = 0usize;
    let mut truncated = false;
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]);
        let chunk_chars = chunk.chars().count();

        if chars_written < max_chars {
            let remaining = max_chars - chars_written;
            if chunk_chars <= remaining {
                output.push_str(&chunk);
                chars_written += chunk_chars;
            } else {
                output.extend(chunk.chars().take(remaining));
                chars_written = max_chars;
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    Ok(CapturedOutput {
        text: output,
        truncated,
    })
}

fn join_output_reader(
    handle: thread::JoinHandle<io::Result<CapturedOutput>>,
    stream_name: &str,
) -> Result<CapturedOutput, String> {
    handle
        .join()
        .map_err(|_| format!("{stream_name} reader thread panicked"))?
        .map_err(|err| format!("failed to read child {stream_name}: {err}"))
}

fn millis_since(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_child_process(_command: &mut Command) {}

#[cfg(unix)]
fn kill_child(child: &mut Child) -> io::Result<()> {
    kill_process_group(child.id()).or_else(|_| child.kill())
}

#[cfg(not(unix))]
fn kill_child(child: &mut Child) -> io::Result<()> {
    child.kill()
}

#[cfg(unix)]
fn kill_process_group(pid: u32) -> io::Result<()> {
    use std::os::raw::c_int;

    const SIGKILL: c_int = 9;

    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }

    let pid = c_int::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "child pid does not fit c_int"))?;
    let result = unsafe { kill(-pid, SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    // 真 spawn 子进程的集成测试：不 mock，真的起 shell 跑 echo/pwd/sleep，
    // 验证 stdout 捕获、退出码、cwd 生效、以及超时真的杀掉进程（用例整体 ~1s 内返回，不真等 5s）。
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // 每个用例独立的临时目录：进程 pid + 原子计数器拼唯一子目录，避免并发撞目录；
    // canonicalize 后与子进程 `pwd` 打印的物理路径一致（macOS 上 /var -> /private/var）。
    fn unique_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = env::temp_dir();
        dir.push(format!("shell_it_{}_{}", std::process::id(), seq));
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::canonicalize(&dir).expect("canonicalize temp dir")
    }

    // 当前宿主平台字符串——run_shell_command_blocking 要求 requested==current，
    // 否则直接返回 platform mismatch 的 failed_result（跑不到真实 spawn）。
    fn host_platform() -> String {
        current_platform().to_string()
    }

    #[test]
    fn echo_captures_stdout_and_exit_code() {
        // 真跑 `echo hello`（zsh / PowerShell 都识别）：stdout 含 hello、退出码 0、未超时。
        let result = run_shell_command_blocking(
            host_platform(),
            "echo hello".to_string(),
            None,
            None,
            None,
            None,
        )
        .expect("worker 层不应报错");
        assert!(
            result.stdout.contains("hello"),
            "stdout 应含 hello，实际: {:?}",
            result.stdout
        );
        assert_eq!(result.exit_code, Some(0), "echo 应以 0 退出");
        assert!(!result.timed_out, "echo 不应超时");
    }

    #[test]
    fn pwd_reflects_requested_cwd() {
        // 真跑 pwd（win: Get-Location）在指定 cwd 下 → stdout 含该目录的物理路径，且结果 cwd 字段回显它。
        let dir = unique_dir();
        let command = if cfg!(target_os = "windows") {
            "Get-Location | ForEach-Object { $_.Path }".to_string()
        } else {
            "pwd".to_string()
        };
        let result = run_shell_command_blocking(
            host_platform(),
            command,
            Some(dir.to_string_lossy().into_owned()),
            None,
            None,
            None,
        )
        .expect("worker 层不应报错");
        assert_eq!(result.exit_code, Some(0), "pwd 应以 0 退出");
        let expected = dir.to_string_lossy();
        assert!(
            result.stdout.contains(expected.as_ref()),
            "stdout 应含 cwd `{expected}`，实际: {:?}",
            result.stdout
        );
        assert_eq!(result.cwd.as_str(), expected.as_ref(), "结果 cwd 应为解析后的目录");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sleep_beyond_timeout_is_killed() {
        // 真跑 sleep 5（win: Start-Sleep 5）配 timeout_ms=200：
        // 断言 timed_out==true，且用例整体远早于 5s 返回（证明进程被杀、没有真等满）。
        let command = if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 5".to_string()
        } else {
            "sleep 5".to_string()
        };
        let started = Instant::now();
        let result = run_shell_command_blocking(
            host_platform(),
            command,
            None,
            Some(200),
            None,
            None,
        )
        .expect("worker 层不应报错");
        let elapsed = started.elapsed();
        assert!(result.timed_out, "sleep 应被判定超时");
        assert!(
            elapsed < Duration::from_secs(3),
            "超时应快速返回(杀掉进程)，实际耗时 {:?}",
            elapsed
        );
    }
}
