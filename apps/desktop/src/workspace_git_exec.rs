//! 加固后的 `git` 子进程构造与执行：普通命令、以及带上限的流式 diff 读取。

use super::types::{GitDiffCapture, GitOutput, MAX_GIT_STDERR_CHARS};
use crate::workspace_common::{read_capped_drain, read_capped_stop};
use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
};

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

pub(super) fn run_git<S>(cwd: &Path, args: &[S]) -> Result<GitOutput, String>
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
pub(super) fn run_git_diff_capped(
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

#[cfg(test)]
#[path = "workspace_git_exec_tests.rs"]
mod tests;
