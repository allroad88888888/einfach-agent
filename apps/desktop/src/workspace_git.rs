use crate::workspace_common::{read_capped_drain, read_capped_stop, resolve_workspace_root};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
};

const DEFAULT_MAX_DIFF_CHARS: usize = 20_000;
const MAX_DIFF_CHARS: usize = 100_000;
// P2 git diff 的 stderr 小量缓冲上限（stdout 走 max_diff_chars 流式 cap）。
const MAX_GIT_STDERR_CHARS: usize = 10_000;

#[derive(Serialize)]
pub struct WorkspaceDiffResult {
    status_short: String,
    stat: Option<String>,
    diff: String,
    changed_files: Vec<String>,
    truncated: bool,
    exit_code: i32,
    stderr: String,
}

struct GitOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

struct GitDiffCapture {
    exit_code: i32,
    text: String,
    truncated: bool,
    stderr: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn get_workspace_diff(
    paths: Option<Vec<String>>,
    staged: Option<bool>,
    max_diff_chars: Option<usize>,
    include_stat: Option<bool>,
    workspace_root: Option<String>,
) -> Result<WorkspaceDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_workspace_diff_blocking(paths, staged, max_diff_chars, include_stat, workspace_root)
    })
    .await
    .map_err(|err| format!("workspace git worker failed: {err}"))?
}

fn get_workspace_diff_blocking(
    paths: Option<Vec<String>>,
    staged: Option<bool>,
    max_diff_chars: Option<usize>,
    include_stat: Option<bool>,
    workspace_root: Option<String>,
) -> Result<WorkspaceDiffResult, String> {
    let max_diff_chars = normalize_max_diff_chars(max_diff_chars);
    let include_stat = include_stat.unwrap_or(true);
    let staged = staged.unwrap_or(false);
    // P1：git cwd/diff 目录不再各用各的裸 cwd，统一走共享 root 解析（显式优先 + git root 兜底 + 拒 `/`）。
    let root = match resolve_workspace_root(workspace_root.as_deref()) {
        Ok(root) => root,
        Err(err) => return Ok(failed_result(err)),
    };
    let pathspecs = match normalize_paths(paths, &root) {
        Ok(paths) => paths,
        Err(err) => return Ok(failed_result(err)),
    };

    // P2：调用方给了 paths 做聚焦 review 时，status 也要按同一批 pathspec 收窄，
    // 否则 status_short/changed_files 混入无关文件（混合改动的 worktree 里可能很大且误导），
    // 与下面已收窄的 diff/stat 不一致。pathspecs 为空时保持全仓 status。
    let status = run_git(&root, &status_args(&pathspecs))?;
    if status.exit_code != 0 {
        return Ok(WorkspaceDiffResult {
            status_short: status.stdout,
            stat: None,
            diff: String::new(),
            changed_files: Vec::new(),
            truncated: false,
            exit_code: status.exit_code,
            stderr: status.stderr,
        });
    }

    let mut stderr_parts = vec![status.stderr];
    let mut stat_exit_code = None;
    let stat = if include_stat {
        let stat_output = run_git(&root, &diff_args(staged, true, &pathspecs))?;
        if stat_output.exit_code != 0 {
            stat_exit_code = Some(stat_output.exit_code);
        }
        stderr_parts.push(stat_output.stderr);
        Some(stat_output.stdout)
    } else {
        None
    };

    let diff_output =
        run_git_diff_capped(&root, &diff_args(staged, false, &pathspecs), max_diff_chars)?;
    let exit_code = if diff_output.exit_code != 0 {
        diff_output.exit_code
    } else {
        stat_exit_code.unwrap_or(diff_output.exit_code)
    };
    stderr_parts.push(diff_output.stderr);
    let stderr = join_stderr(stderr_parts);

    Ok(WorkspaceDiffResult {
        changed_files: parse_changed_files(&status.stdout),
        status_short: status.stdout,
        stat,
        diff: diff_output.text,
        truncated: diff_output.truncated,
        exit_code,
        stderr,
    })
}

fn failed_result(stderr: String) -> WorkspaceDiffResult {
    WorkspaceDiffResult {
        status_short: String::new(),
        stat: None,
        diff: String::new(),
        changed_files: Vec::new(),
        truncated: false,
        exit_code: 1,
        stderr,
    }
}

fn normalize_max_diff_chars(max_diff_chars: Option<usize>) -> usize {
    match max_diff_chars {
        Some(value) if value > 0 => value.min(MAX_DIFF_CHARS),
        _ => DEFAULT_MAX_DIFF_CHARS,
    }
}

fn normalize_paths(paths: Option<Vec<String>>, root: &Path) -> Result<Vec<String>, String> {
    let Some(paths) = paths else {
        return Ok(Vec::new());
    };

    let mut normalized = Vec::new();
    for path in paths {
        normalized.push(normalize_path(&path, root)?);
    }
    Ok(normalized)
}

fn normalize_path(path: &str, root: &Path) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("git diff path cannot be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err(format!("git diff path `{trimmed}` contains a NUL byte"));
    }

    let input = PathBuf::from(trimmed);
    let relative = if input.is_absolute() {
        relative_from_absolute(&input, root)?
    } else {
        relative_from_relative(&input, root)?
    };

    if relative.as_os_str().is_empty() {
        return Err(
            "git diff path cannot resolve to the workspace root; omit paths instead".to_string(),
        );
    }

    Ok(pathbuf_to_git_path(&relative))
}

fn relative_from_absolute(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let candidate = lexical_normalize_absolute(path)?;

    if !candidate.starts_with(root) {
        return Err(format!(
            "git diff path `{}` escapes workspace root `{}`",
            path.to_string_lossy(),
            root.to_string_lossy()
        ));
    }
    ensure_existing_ancestor_in_root(&candidate, root, path)?;

    candidate
        .strip_prefix(root)
        .map(PathBuf::from)
        .map_err(|err| format!("failed to make path relative to workspace root: {err}"))
}

fn relative_from_relative(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "git diff path `{}` must stay inside workspace root",
                    path.to_string_lossy()
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "git diff path `{}` must be relative to workspace root",
                    path.to_string_lossy()
                ));
            }
        }
    }

    let candidate = root.join(&relative);
    ensure_existing_ancestor_in_root(&candidate, root, path)?;

    Ok(relative)
}

fn ensure_existing_ancestor_in_root(
    candidate: &Path,
    root: &Path,
    original: &Path,
) -> Result<(), String> {
    let mut existing = candidate.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return Err(format!(
                "git diff path `{}` has no accessible parent",
                original.to_string_lossy()
            ));
        }
    }

    let canonical = fs::canonicalize(&existing).map_err(|err| {
        format!(
            "failed to resolve path `{}`: {err}",
            existing.to_string_lossy()
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "git diff path `{}` escapes workspace root `{}`",
            original.to_string_lossy(),
            root.to_string_lossy()
        ));
    }

    Ok(())
}

fn lexical_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "absolute git diff path `{}` cannot be normalized",
                        path.to_string_lossy()
                    ));
                }
            }
        }
    }
    Ok(normalized)
}

fn pathbuf_to_git_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

// P2：git status 的 pathspec 收窄。拼参数方式对齐 diff_args，非空时用 `--` 分隔 pathspec；
// paths 为空则退回全仓 `status --short`。
fn status_args(paths: &[String]) -> Vec<String> {
    let mut args = vec!["status".to_string(), "--short".to_string()];
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    args
}

fn diff_args(staged: bool, stat: bool, paths: &[String]) -> Vec<String> {
    // P1：diff 与 stat 都要堵死外部 diff / textconv driver（"只读" review 绝不 spawn 外部命令）。
    //   · `-c diff.external=` 是全局选项，必须放在子命令 `diff` 之前，用空值覆盖仓库 config 的 diff.external；
    //   · `--no-ext-diff` / `--no-textconv` 是 diff 子命令选项，放 `diff` 之后。
    // 与 git_command 里的 GIT_EXTERNAL_DIFF="" 叠成 config + env + 命令行 flag 三重，任何来源都盖不过。
    let mut args = vec![
        "-c".to_string(),
        "diff.external=".to_string(),
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
    ];
    if staged {
        args.push("--cached".to_string());
    }
    if stat {
        args.push("--stat".to_string());
    }
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    args
}

/// 构造一条已做安全加固的 `git` 子进程 Command——run_git 与 run_git_diff_capped 共用它，
/// 把 hardening 收敛到唯一入口，避免两处 git 调用各写各的、逐渐漂移（P1/P2）。
///   · `.current_dir(cwd)`：统一在解析好的 workspace root 下执行（不再各用各的裸 cwd）。
///   · `.stdin(Stdio::null())`：git 永远读不到 stdin，杜绝挂在等待输入上。
///   · env `GIT_LITERAL_PATHSPECS=1`（P2）：status/diff/stat 的所有 pathspec 一律按字面路径处理，
///     `:(top)`、`*.ts`、`:` 等 pathspec 元字符不再被 git 当语法展开——聚焦 review 不混入无关文件。
///     （normalize_paths 的 workspace 内 confine 校验照旧，这里只改 git 对 pathspec 的解释方式，不放松路径限制。）
///   · env `GIT_EXTERNAL_DIFF=""`（P1）：清空外部 diff driver 的环境变量兜底，配合子命令的
///     `-c diff.external=` 与 `--no-ext-diff`，任何 config/env/flag 都盖不过——只读 diff 绝不 spawn 外部命令。
///   · env `GIT_OPTIONAL_LOCKS=0`（P2）：禁止 git 为可选优化去拿锁——否则 `status --short` 遇到过期的
///     index stat 会顺手刷新并重写 `.git/index`，让号称只读的 review 工具变更了仓库元数据。关掉后只读到底。
fn git_command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_EXTERNAL_DIFF", "")
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn run_git<S>(cwd: &Path, args: &[S]) -> Result<GitOutput, String>
where
    S: AsRef<str>,
{
    let output = git_command(cwd)
        .args(args.iter().map(|arg| arg.as_ref()))
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;

    Ok(GitOutput {
        exit_code: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// 流式跑 `git diff`：stdout 增量读到 char 上限即停并杀掉 git（P2：不再 `output()` 全缓冲，
/// 大 diff/lockfile 不会 OOM 或挂住 worker）。stderr 单开线程排空、小量缓冲，避免管道撑满卡死 git。
fn run_git_diff_capped(
    cwd: &Path,
    args: &[String],
    max_chars: usize,
) -> Result<GitDiffCapture, String> {
    // 走共享 git_command：current_dir + stdin(null) + P1/P2 env 全在那里统一施加。
    let mut child = git_command(cwd)
        .args(args.iter().map(|arg| arg.as_str()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run git: {err}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture git stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture git stderr".to_string())?;

    // stderr 单开线程排空到 EOF（只保留前 MAX_GIT_STDERR_CHARS），避免大 stderr 撑满管道卡死 git。
    let stderr_handle = thread::spawn(move || read_capped_drain(stderr, MAX_GIT_STDERR_CHARS));

    // stdout 增量读到上限就 break（不再继续读）。
    let capped = read_capped_stop(&mut stdout, max_chars)
        .map_err(|err| format!("failed to read git diff output: {err}"))?;
    if capped.truncated {
        // 到上限即杀掉 git，别让它继续产出/挂住 worker。
        let _ = child.kill();
    }
    // 关闭 stdout 读端：git 若仍在写会收到 SIGPIPE 自行退出。
    drop(stdout);

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for git: {err}"))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "git stderr reader thread panicked".to_string())?
        .map_err(|err| format!("failed to read git stderr: {err}"))?;

    // truncated 是我们主动杀掉 git 造成的，不是 git 出错——报成功退出码，别让前端误判为失败。
    let exit_code = if capped.truncated {
        0
    } else {
        status.code().unwrap_or(1)
    };

    Ok(GitDiffCapture {
        exit_code,
        text: capped.text,
        truncated: capped.truncated,
        stderr: stderr.text,
    })
}

fn parse_changed_files(status_short: &str) -> Vec<String> {
    status_short
        .lines()
        .filter_map(|line| {
            let path = line.get(3..)?.trim();
            if path.is_empty() {
                return None;
            }
            Some(
                path.rsplit_once(" -> ")
                    .map_or(path, |(_, new_path)| new_path)
                    .to_string(),
            )
        })
        .collect()
}

fn join_stderr(parts: impl IntoIterator<Item = String>) -> String {
    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // 真 git 仓库的临时 workspace：唯一目录 + git init + 初始提交。返回 canonicalize 后的 root。
    // 两个带独特标记的文件先提交为基线，供后续改动 diff。
    fn init_git_workspace() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!("ws_git_it_{}_{}", std::process::id(), seq));
        fs::create_dir_all(&dir).expect("create temp root");
        let root = fs::canonicalize(&dir).expect("canonicalize temp root");

        fs::write(root.join("a.txt"), "ALPHA_MARKER\n").expect("seed a.txt");
        fs::write(root.join("b.txt"), "BETA_MARKER\n").expect("seed b.txt");
        run_setup_git(&root, &["init", "-q"]);
        // 显式设本地身份，避免依赖全局 git config（CI/干净机器上可能没配）。
        run_setup_git(&root, &["config", "user.email", "test@example.com"]);
        run_setup_git(&root, &["config", "user.name", "Test"]);
        run_setup_git(&root, &["add", "-A"]);
        // 关签名，避免全局 commit.gpgsign=true 但无密钥时提交失败。
        run_setup_git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
        );
        root
    }

    // 真跑一条 git 命令（测试搭台用，非被测代码）；失败即 panic 便于定位。
    fn run_setup_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("spawn git for test setup");
        assert!(
            output.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn root_arg(root: &Path) -> Option<String> {
        Some(root.to_string_lossy().into_owned())
    }

    #[test]
    fn diff_reports_working_tree_change() {
        // 改动已提交文件 → get_workspace_diff 的 diff 含改动、status/changed_files 合理。
        let root = init_git_workspace();
        fs::write(root.join("a.txt"), "ALPHA_MODIFIED\n").expect("modify a.txt");

        let result = get_workspace_diff_blocking(None, None, None, None, root_arg(&root))
            .expect("diff worker should not error");
        assert_eq!(result.exit_code, 0, "git 应成功，stderr: {}", result.stderr);
        assert!(
            result.diff.contains("ALPHA_MODIFIED"),
            "diff 应含改动内容: {}",
            result.diff
        );
        assert!(
            result.changed_files.contains(&"a.txt".to_string()),
            "changed_files 应含 a.txt: {:?}",
            result.changed_files
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn diff_scoped_to_pathspec_excludes_unrelated_files() {
        // P2 scoped：同时改 a.txt / b.txt，但只请求 a.txt → diff / changed_files 都不含 b.txt。
        let root = init_git_workspace();
        fs::write(root.join("a.txt"), "ALPHA_MODIFIED\n").expect("modify a.txt");
        fs::write(root.join("b.txt"), "BETA_MODIFIED\n").expect("modify b.txt");

        let result = get_workspace_diff_blocking(
            Some(vec!["a.txt".to_string()]),
            None,
            None,
            None,
            root_arg(&root),
        )
        .expect("diff worker should not error");
        assert_eq!(result.exit_code, 0, "git 应成功，stderr: {}", result.stderr);
        assert!(
            result.diff.contains("ALPHA_MODIFIED"),
            "diff 应含被请求文件的改动: {}",
            result.diff
        );
        assert!(
            !result.diff.contains("BETA_MODIFIED"),
            "scoped diff 不应含未请求的 b.txt 改动: {}",
            result.diff
        );
        assert_eq!(
            result.changed_files,
            vec!["a.txt".to_string()],
            "scoped status 只应含 a.txt，实际: {:?}",
            result.changed_files
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn diff_rejects_path_escaping_workspace() {
        // confine：请求 ../ 越界 pathspec → 结构化失败(exit_code=1，stderr 说明越界)。
        let root = init_git_workspace();
        let result = get_workspace_diff_blocking(
            Some(vec!["../outside.txt".to_string()]),
            None,
            None,
            None,
            root_arg(&root),
        )
        .expect("diff worker should not error");
        assert_eq!(result.exit_code, 1, "越界 pathspec 应失败");
        assert!(
            result.stderr.contains("stay inside") || result.stderr.contains("escapes"),
            "stderr 应说明越界，实际: {}",
            result.stderr
        );

        let _ = fs::remove_dir_all(&root);
    }

    // P1：diff/stat 参数三件套——`-c diff.external=` 在 `diff` 之前，且带 `--no-ext-diff` / `--no-textconv`。
    #[test]
    fn diff_args_disable_external_diff_and_textconv() {
        for (staged, stat) in [(false, false), (true, false), (false, true), (true, true)] {
            let args = diff_args(staged, stat, &[]);
            let external_idx = args
                .iter()
                .position(|arg| arg == "diff.external=")
                .expect("diff.external= present");
            let diff_idx = args
                .iter()
                .position(|arg| arg == "diff")
                .expect("diff subcommand present");
            // `-c diff.external=` 必须作为全局选项排在子命令 `diff` 之前。
            assert!(
                external_idx < diff_idx,
                "-c diff.external= must precede diff"
            );
            assert_eq!(args.get(external_idx - 1).map(String::as_str), Some("-c"));
            assert!(args.iter().any(|arg| arg == "--no-ext-diff"));
            assert!(args.iter().any(|arg| arg == "--no-textconv"));
        }
    }

    // P1：--no-ext-diff / --no-textconv 是 diff 专属选项，status 不该带（带了会报错）；
    // status 的外部命令兜底靠 git_command 的 env，参数层保持干净。
    #[test]
    fn status_args_have_no_diff_only_flags() {
        let args = status_args(&[]);
        assert!(!args.iter().any(|arg| arg == "--no-ext-diff"));
        assert!(!args.iter().any(|arg| arg == "--no-textconv"));
        assert!(!args.iter().any(|arg| arg == "diff.external="));
    }

    // P1/P2：共享 git_command 的 env 兜底——GIT_LITERAL_PATHSPECS=1 + 清空 GIT_EXTERNAL_DIFF。
    #[test]
    fn git_command_hardens_env() {
        let command = git_command(Path::new("."));
        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();

        let literal = envs.iter().find(|(key, _)| key == "GIT_LITERAL_PATHSPECS");
        assert_eq!(
            literal.map(|(_, value)| value.clone()),
            Some(Some("1".to_string())),
            "GIT_LITERAL_PATHSPECS must be set to 1"
        );

        let external = envs.iter().find(|(key, _)| key == "GIT_EXTERNAL_DIFF");
        assert_eq!(
            external.map(|(_, value)| value.clone()),
            Some(Some(String::new())),
            "GIT_EXTERNAL_DIFF must be cleared to empty"
        );
    }
}
