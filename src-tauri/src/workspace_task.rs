use crate::workspace_common::{read_capped_drain, resolve_workspace_root};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs, io,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS: usize = 20_000;
const MAX_OUTPUT_CHARS: usize = 100_000;
const WAIT_POLL_INTERVAL_MS: u64 = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTaskResult {
    ok: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    truncated: bool,
    command: Vec<String>,
    cwd: String,
    kind: String,
}

#[derive(Clone, Copy)]
enum TaskKind {
    Test,
    Build,
    Lint,
    Typecheck,
    CargoCheck,
}

impl TaskKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "test" => Ok(Self::Test),
            "build" => Ok(Self::Build),
            "lint" => Ok(Self::Lint),
            "typecheck" => Ok(Self::Typecheck),
            "cargo_check" => Ok(Self::CargoCheck),
            _ => Err(format!(
                "unsupported task kind `{value}`; expected `test`, `build`, `lint`, `typecheck`, or `cargo_check`"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Test => "test",
            Self::Build => "build",
            Self::Lint => "lint",
            Self::Typecheck => "typecheck",
            Self::CargoCheck => "cargo_check",
        }
    }

    fn package_script(self) -> Option<&'static str> {
        match self {
            Self::Test => Some("test"),
            Self::Build => Some("build"),
            Self::Lint => Some("lint"),
            Self::Typecheck => Some("typecheck"),
            Self::CargoCheck => None,
        }
    }
}

#[derive(Clone, Copy)]
enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    fn executable(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }
}

struct TaskSpec {
    program: String,
    args: Vec<String>,
}

impl TaskSpec {
    fn command(&self) -> Vec<String> {
        let mut command = Vec::with_capacity(self.args.len() + 1);
        command.push(self.program.clone());
        command.extend(self.args.iter().cloned());
        command
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn run_workspace_task(
    kind: String,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
    workspace_root: Option<String>,
) -> Result<WorkspaceTaskResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_workspace_task_blocking(kind, timeout_ms, max_output_chars, workspace_root)
    })
    .await
    .map_err(|err| format!("run_workspace_task worker failed: {err}"))?
}

fn run_workspace_task_blocking(
    kind: String,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
    workspace_root: Option<String>,
) -> Result<WorkspaceTaskResult, String> {
    let start = Instant::now();
    let kind_input = kind.trim().to_string();
    let task_kind = match TaskKind::parse(&kind_input) {
        Ok(kind) => kind,
        Err(err) => {
            return Ok(failed_result(
                kind_input,
                Vec::new(),
                String::new(),
                err,
                start,
            ));
        }
    };
    let kind = task_kind.as_str().to_string();

    let root = match resolve_workspace_root(workspace_root.as_deref()) {
        Ok(root) => root,
        Err(err) => {
            return Ok(failed_result(kind, Vec::new(), String::new(), err, start));
        }
    };
    if let Err(err) = ensure_workspace_dir(&root) {
        return Ok(failed_result(
            kind,
            Vec::new(),
            display_path(&root),
            err,
            start,
        ));
    }

    let cwd = display_path(&root);
    let task = match resolve_task(&root, task_kind) {
        Ok(task) => task,
        Err(err) => {
            return Ok(failed_result(kind, Vec::new(), cwd, err, start));
        }
    };
    let command = task.command();
    let timeout_ms = normalize_timeout_ms(timeout_ms);
    let max_output_chars = normalize_max_output_chars(max_output_chars);

    let mut child = match spawn_task(&task, &root) {
        Ok(child) => child,
        Err(err) => {
            return Ok(failed_result(kind, command, cwd, err, start));
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture task stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture task stderr".to_string())?;

    let stdout_handle = thread::spawn(move || read_capped_drain(stdout, max_output_chars));
    let stderr_handle = thread::spawn(move || read_capped_drain(stderr, max_output_chars));

    let (exit_code, timed_out) = wait_for_child(&mut child, timeout_ms)?;
    let duration_ms = millis_since(start);
    let stdout = join_output_reader(stdout_handle, "stdout")?;
    let stderr = join_output_reader(stderr_handle, "stderr")?;

    Ok(WorkspaceTaskResult {
        ok: !timed_out && exit_code == 0,
        exit_code,
        stdout: stdout.text,
        stderr: stderr.text,
        duration_ms,
        timed_out,
        truncated: stdout.truncated || stderr.truncated,
        command,
        cwd,
        kind,
    })
}

fn resolve_task(root: &Path, kind: TaskKind) -> Result<TaskSpec, String> {
    if matches!(kind, TaskKind::CargoCheck) {
        return resolve_cargo_check(root);
    }

    let script = kind
        .package_script()
        .ok_or_else(|| "task kind does not map to a package script".to_string())?;
    let package = read_package_json(root)?;
    ensure_package_script(&package, script)?;
    let manager = detect_package_manager(root, &package);

    Ok(TaskSpec {
        program: manager.executable().to_string(),
        args: vec!["run".to_string(), script.to_string()],
    })
}

fn resolve_cargo_check(root: &Path) -> Result<TaskSpec, String> {
    if root.join("Cargo.toml").is_file() {
        return Ok(TaskSpec {
            program: "cargo".to_string(),
            args: vec!["check".to_string()],
        });
    }

    let tauri_manifest = Path::new("src-tauri").join("Cargo.toml");
    if root.join(&tauri_manifest).is_file() {
        return Ok(TaskSpec {
            program: "cargo".to_string(),
            args: vec![
                "check".to_string(),
                "--manifest-path".to_string(),
                path_to_command_arg(&tauri_manifest),
            ],
        });
    }

    Err("cargo_check requires `Cargo.toml` or `src-tauri/Cargo.toml` in the workspace".to_string())
}

fn read_package_json(root: &Path) -> Result<Value, String> {
    let path = root.join("package.json");
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read `{}`: {err}", display_path(&path)))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse `{}`: {err}", display_path(&path)))
}

fn ensure_package_script(package: &Value, script: &str) -> Result<(), String> {
    let Some(scripts) = package.get("scripts").and_then(Value::as_object) else {
        return Err("package.json is missing a `scripts` object".to_string());
    };
    match scripts.get(script).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(()),
        _ => Err(format!(
            "package.json is missing a non-empty `{script}` script"
        )),
    }
}

fn detect_package_manager(root: &Path, package: &Value) -> PackageManager {
    detect_package_manager_from_lockfile(root)
        .or_else(|| detect_package_manager_from_package_json(package))
        .unwrap_or(PackageManager::Npm)
}

fn detect_package_manager_from_package_json(package: &Value) -> Option<PackageManager> {
    let value = package.get("packageManager")?.as_str()?.trim();
    if value.starts_with("pnpm@") || value == "pnpm" {
        Some(PackageManager::Pnpm)
    } else if value.starts_with("yarn@") || value == "yarn" {
        Some(PackageManager::Yarn)
    } else if value.starts_with("bun@") || value == "bun" {
        Some(PackageManager::Bun)
    } else if value.starts_with("npm@") || value == "npm" {
        Some(PackageManager::Npm)
    } else {
        None
    }
}

fn detect_package_manager_from_lockfile(root: &Path) -> Option<PackageManager> {
    if root.join("pnpm-lock.yaml").is_file() {
        Some(PackageManager::Pnpm)
    } else if root.join("yarn.lock").is_file() {
        Some(PackageManager::Yarn)
    } else if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() {
        Some(PackageManager::Bun)
    } else if root.join("package-lock.json").is_file() || root.join("npm-shrinkwrap.json").is_file()
    {
        Some(PackageManager::Npm)
    } else {
        None
    }
}

fn spawn_task(task: &TaskSpec, root: &Path) -> Result<Child, String> {
    let mut command = Command::new(&task.program);
    command
        .args(&task.args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    configure_child_process(&mut command);

    command
        .spawn()
        .map_err(|err| format!("failed to spawn `{}`: {err}", task.program))
}

fn wait_for_child(child: &mut Child, timeout_ms: u64) -> Result<(i32, bool), String> {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to poll task process: {err}"))?
        {
            return Ok((status.code().unwrap_or(1), false));
        }

        if start.elapsed() >= timeout {
            if let Err(kill_err) = kill_child(child) {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|err| format!("failed to poll timed out task process: {err}"))?
                {
                    return Ok((status.code().unwrap_or(1), false));
                }

                return Err(format!("failed to kill timed out task process: {kill_err}"));
            }

            let status = child
                .wait()
                .map_err(|err| format!("failed to wait for timed out task process: {err}"))?;
            return Ok((status.code().unwrap_or(-1), true));
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MS));
    }
}

fn join_output_reader(
    handle: thread::JoinHandle<io::Result<crate::workspace_common::CappedRead>>,
    stream_name: &str,
) -> Result<crate::workspace_common::CappedRead, String> {
    handle
        .join()
        .map_err(|_| format!("{stream_name} reader thread panicked"))?
        .map_err(|err| format!("failed to read task {stream_name}: {err}"))
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

fn ensure_workspace_dir(root: &Path) -> Result<(), String> {
    let metadata = fs::metadata(root).map_err(|err| {
        format!(
            "workspace root `{}` is not accessible: {err}",
            display_path(root)
        )
    })?;
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(format!(
            "workspace root `{}` is not a directory",
            display_path(root)
        ))
    }
}

fn failed_result(
    kind: String,
    command: Vec<String>,
    cwd: String,
    stderr: String,
    start: Instant,
) -> WorkspaceTaskResult {
    WorkspaceTaskResult {
        ok: false,
        exit_code: 1,
        stdout: String::new(),
        stderr,
        duration_ms: millis_since(start),
        timed_out: false,
        truncated: false,
        command,
        cwd,
        kind,
    }
}

fn millis_since(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn path_to_command_arg(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
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
