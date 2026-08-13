//! workspace git diff 的阻塞式主流程：解析参数、跑 status/stat/diff、汇总结果。

use super::args::{diff_args, diff_name_only_args, normalize_base, normalize_max_diff_chars, status_args};
use super::exec::{run_git, run_git_diff_capped};
use super::path::normalize_paths;
use super::types::WorkspaceDiffResult;
use crate::workspace_common::resolve_workspace_root;

pub(super) fn get_workspace_diff_blocking(
    paths: Option<Vec<String>>,
    staged: Option<bool>,
    base: Option<String>,
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
    let base = match normalize_base(base) {
        Ok(base) => base,
        Err(err) => return Ok(failed_result(err)),
    };
    if let Some(base_ref) = base.as_deref() {
        let commit = format!("{base_ref}^{{commit}}");
        let verify = run_git(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &commit,
            ],
        )?;
        if verify.exit_code != 0 {
            return Ok(failed_result(format!(
                "git diff base `{base_ref}` does not resolve to a commit{}",
                if verify.stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", verify.stderr.trim())
                }
            )));
        }
    }

    // P2：调用方给了 paths 做聚焦 review 时，status 也要按同一批 pathspec 收窄，
    // 否则 status_short/changed_files 混入无关文件（混合改动的 worktree 里可能很大且误导），
    // 与下面已收窄的 diff/stat 不一致。pathspecs 为空时保持全仓 status。
    let status = run_git(&root, &status_args(&pathspecs))?;
    if status.exit_code != 0 {
        return Ok(WorkspaceDiffResult {
            base,
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
        let stat_output = run_git(&root, &diff_args(staged, base.as_deref(), true, &pathspecs))?;
        if stat_output.exit_code != 0 {
            stat_exit_code = Some(stat_output.exit_code);
        }
        stderr_parts.push(stat_output.stderr);
        Some(stat_output.stdout)
    } else {
        None
    };

    let diff_output = run_git_diff_capped(
        &root,
        &diff_args(staged, base.as_deref(), false, &pathspecs),
        max_diff_chars,
    )?;
    let exit_code = if diff_output.exit_code != 0 {
        diff_output.exit_code
    } else {
        stat_exit_code.unwrap_or(diff_output.exit_code)
    };
    stderr_parts.push(diff_output.stderr);

    let changed_files = if base.is_some() {
        let names = run_git(
            &root,
            &diff_name_only_args(staged, base.as_deref(), &pathspecs),
        )?;
        if names.exit_code != 0 {
            stderr_parts.push(names.stderr);
            Vec::new()
        } else {
            names
                .stdout
                .lines()
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect()
        }
    } else {
        parse_changed_files(&status.stdout)
    };
    let stderr = join_stderr(stderr_parts);

    Ok(WorkspaceDiffResult {
        base,
        changed_files,
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
        base: None,
        status_short: String::new(),
        stat: None,
        diff: String::new(),
        changed_files: Vec::new(),
        truncated: false,
        exit_code: 1,
        stderr,
    }
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
#[path = "workspace_git_pipeline_tests.rs"]
mod tests;
