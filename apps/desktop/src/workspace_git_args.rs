//! git diff/status 请求参数的归一化与子命令 argv 构造。

use super::types::{DEFAULT_MAX_DIFF_CHARS, MAX_DIFF_CHARS};

pub(super) fn normalize_base(base: Option<String>) -> Result<Option<String>, String> {
    let Some(base) = base else {
        return Ok(None);
    };
    let trimmed = base.trim();
    if trimmed.is_empty() {
        return Err("git diff base cannot be empty".to_string());
    }
    if trimmed.starts_with('-')
        || trimmed
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(
            "git diff base must be a ref or commit without leading `-`, whitespace, or control characters"
                .to_string(),
        );
    }
    Ok(Some(trimmed.to_string()))
}

pub(super) fn normalize_max_diff_chars(max_diff_chars: Option<usize>) -> usize {
    match max_diff_chars {
        Some(value) if value > 0 => value.min(MAX_DIFF_CHARS),
        _ => DEFAULT_MAX_DIFF_CHARS,
    }
}

// P2：git status 的 pathspec 收窄。拼参数方式对齐 diff_args，非空时用 `--` 分隔 pathspec；
// paths 为空则退回全仓 `status --short`。
pub(super) fn status_args(paths: &[String]) -> Vec<String> {
    let mut args = vec!["status".to_string(), "--short".to_string()];
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    args
}

pub(super) fn diff_args(staged: bool, base: Option<&str>, stat: bool, paths: &[String]) -> Vec<String> {
    diff_args_with_format(staged, base, stat.then_some("--stat"), paths)
}

pub(super) fn diff_name_only_args(staged: bool, base: Option<&str>, paths: &[String]) -> Vec<String> {
    diff_args_with_format(staged, base, Some("--name-only"), paths)
}

fn diff_args_with_format(
    staged: bool,
    base: Option<&str>,
    format: Option<&str>,
    paths: &[String],
) -> Vec<String> {
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
    if let Some(format) = format {
        args.push(format.to_string());
    }
    if let Some(base) = base {
        args.push(base.to_string());
    }
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    args
}

#[cfg(test)]
#[path = "workspace_git_args_tests.rs"]
mod tests;
