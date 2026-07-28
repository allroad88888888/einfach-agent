use serde::Serialize;
use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_MAX_OUTPUT_CHARS: usize = 20_000;
const MAX_OUTPUT_CHARS: usize = 100_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const WAIT_POLL_INTERVAL_MS: u64 = 10;
// 直接子进程退出后，残留在管道里的输出只有一个管道缓冲区那么多，读完是微秒级的；
// 留 500ms 是给线程调度的余量，正常命令不会等满（读完即返回）。
const ORPHAN_DRAIN_GRACE_MS: u64 = 500;
// 杀掉进程组到写端真正关闭之间同样只需调度余量。
const ORPHAN_KILL_GRACE_MS: u64 = 500;

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
    /// 命令留下了仍持有 stdout/stderr 的后台进程，它们已被强制清理。
    /// 调用方据此知道 `cmd &` 起的服务并没有活下来。
    background_processes_killed: bool,
}

struct ShellSpec {
    program: &'static str,
    args: &'static [&'static str],
    display: String,
}

#[derive(Default)]
struct CapturedOutput {
    text: String,
    chars_written: usize,
    truncated: bool,
}

/// 读线程与调用线程共享捕获缓冲：读线程可能因孤儿进程握着管道而永不结束，
/// 此时调用线程仍要能取走已经读到的部分输出。
type OutputSink = Arc<Mutex<CapturedOutput>>;

type ReaderHandle = (thread::JoinHandle<io::Result<()>>, &'static str);

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

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    max_chars: usize,
    sink: &OutputSink,
) -> thread::JoinHandle<io::Result<()>> {
    let sink = Arc::clone(sink);
    thread::spawn(move || read_capped_into(reader, max_chars, &sink))
}

fn read_capped_into<R: Read>(mut reader: R, max_chars: usize, sink: &OutputSink) -> io::Result<()> {
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            return Ok(());
        }

        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]);
        let chunk_chars = chunk.chars().count();
        let mut captured = lock_sink(sink);

        if captured.chars_written < max_chars {
            let remaining = max_chars - captured.chars_written;
            if chunk_chars <= remaining {
                captured.text.push_str(&chunk);
                captured.chars_written += chunk_chars;
            } else {
                captured.text.extend(chunk.chars().take(remaining));
                captured.chars_written = max_chars;
                captured.truncated = true;
            }
        } else {
            captured.truncated = true;
        }
    }
}

// 读线程 panic 会毒化锁，但缓冲里已捕获的内容仍然有效，照常取用。
fn lock_sink(sink: &OutputSink) -> MutexGuard<'_, CapturedOutput> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn take_captured(sink: &OutputSink) -> CapturedOutput {
    let mut captured = lock_sink(sink);
    CapturedOutput {
        text: std::mem::take(&mut captured.text),
        chars_written: captured.chars_written,
        truncated: captured.truncated,
    }
}

/// 直接子进程已经退出，但 stdout/stderr 的写端可能还被它派生的后台孙进程持有
/// （`cmd &`、nohup 之类）。这种情况下读线程永远等不到 EOF —— 超时只覆盖
/// `wait_for_child`，覆盖不到这里，无条件 join 会让整个调用永久挂起。
///
/// 所以先留一小段时间读完残留输出；读不完就说明确实有孤儿握着管道，杀掉整个进程组
/// 逼出 EOF；仍读不完则放弃读线程，用共享缓冲里已捕获的部分输出返回。
///
/// 返回是否清理过后台进程。正常退出且已收到 EOF 的命令不会走到 kill 分支，
/// 真正 daemon 化（关掉继承 fd）的进程同样不受影响。
fn drain_output_readers(child: &mut Child, readers: Vec<ReaderHandle>) -> Result<bool, String> {
    let pending = wait_for_readers(readers, Duration::from_millis(ORPHAN_DRAIN_GRACE_MS))?;
    if pending.is_empty() {
        return Ok(false);
    }

    let _ = kill_child(child);
    let _ = child.try_wait();
    let _ = wait_for_readers(pending, Duration::from_millis(ORPHAN_KILL_GRACE_MS))?;
    Ok(true)
}

/// 在 deadline 内轮询回收已结束的读线程，返回仍未结束的那些（不 join，避免阻塞）。
fn wait_for_readers(
    readers: Vec<ReaderHandle>,
    timeout: Duration,
) -> Result<Vec<ReaderHandle>, String> {
    let start = Instant::now();
    let mut pending = readers;

    loop {
        let mut still_reading = Vec::with_capacity(pending.len());
        for (handle, stream_name) in pending {
            if handle.is_finished() {
                join_output_reader(handle, stream_name)?;
            } else {
                still_reading.push((handle, stream_name));
            }
        }
        pending = still_reading;

        if pending.is_empty() || start.elapsed() >= timeout {
            return Ok(pending);
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS));
    }
}

fn join_output_reader(
    handle: thread::JoinHandle<io::Result<()>>,
    stream_name: &str,
) -> Result<(), String> {
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
        assert_eq!(
            result.cwd.as_str(),
            expected.as_ref(),
            "结果 cwd 应为解析后的目录"
        );
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
        let result =
            run_shell_command_blocking(host_platform(), command, None, Some(200), None, None)
                .expect("worker 层不应报错");
        let elapsed = started.elapsed();
        assert!(result.timed_out, "sleep 应被判定超时");
        assert!(
            elapsed < Duration::from_secs(3),
            "超时应快速返回(杀掉进程)，实际耗时 {:?}",
            elapsed
        );
    }

    #[cfg(unix)]
    #[test]
    fn background_process_holding_pipe_does_not_hang_the_call() {
        // 回归用例（对应实测的 96 分钟挂死）：`cmd &` 让孙进程继承 stdout 管道，
        // 父 shell 立刻退出 —— 超时只管直接子进程，所以修复前读线程等不到 EOF、
        // 整个调用一直挂到孤儿自己退出为止（`npm run dev` 这种就是永久）。
        //
        // 两个后台进程各自证明一件事：`sleep 30` 长期握着管道，修复前会把调用拖满
        // 30s（远超下面的 5s 断言）；短命的 touch 则证明进程组真的被杀掉了——
        // 只要它还活着，1s 后 marker 就会出现。
        let dir = unique_dir();
        let marker = dir.join("orphan-survived");
        let command = format!(
            "sleep 30 & (sleep 1 && touch {}) & echo started",
            marker.to_string_lossy()
        );

        let started = Instant::now();
        let result =
            run_shell_command_blocking(host_platform(), command, None, Some(10_000), None, None)
                .expect("worker 层不应报错");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(5),
            "后台进程握住管道时调用仍应快速返回，实际耗时 {:?}",
            elapsed
        );
        assert_eq!(result.exit_code, Some(0), "父 shell 应以 0 退出");
        assert!(
            result.stdout.contains("started"),
            "放弃读线程前已捕获的输出不应丢失，实际: {:?}",
            result.stdout
        );
        assert!(
            result.background_processes_killed,
            "应标记后台进程已被清理"
        );
        assert!(!result.timed_out, "父 shell 未超时，不应标记 timed_out");

        // 跨过孤儿的 1s touch 时点再检查：文件不存在才说明进程组真的被杀了。
        thread::sleep(Duration::from_millis(1_500));
        assert!(
            !marker.exists(),
            "孤儿进程应已被杀死，不应还能创建 {}",
            marker.to_string_lossy()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normal_command_does_not_report_background_kill() {
        // 反向断言：正常退出、管道正常 EOF 的命令不进 kill 分支，也不该被加上 grace 延迟。
        let started = Instant::now();
        let result = run_shell_command_blocking(
            host_platform(),
            "echo done".to_string(),
            None,
            None,
            None,
            None,
        )
        .expect("worker 层不应报错");
        let elapsed = started.elapsed();

        assert!(
            !result.background_processes_killed,
            "普通命令不应报告清理后台进程"
        );
        assert!(
            elapsed < Duration::from_millis(ORPHAN_DRAIN_GRACE_MS),
            "普通命令不应等满 drain grace，实际耗时 {:?}",
            elapsed
        );
    }
}
