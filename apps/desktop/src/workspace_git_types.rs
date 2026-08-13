//! workspace git 差异查询的结果类型、常量与内部输出结构。

use serde::Serialize;

pub(super) const DEFAULT_MAX_DIFF_CHARS: usize = 20_000;
pub(super) const MAX_DIFF_CHARS: usize = 100_000;
// P2 git diff 的 stderr 小量缓冲上限（stdout 走 max_diff_chars 流式 cap）。
pub(super) const MAX_GIT_STDERR_CHARS: usize = 10_000;

#[derive(Serialize)]
pub struct WorkspaceDiffResult {
    pub(super) base: Option<String>,
    pub(super) status_short: String,
    pub(super) stat: Option<String>,
    pub(super) diff: String,
    pub(super) changed_files: Vec<String>,
    pub(super) truncated: bool,
    pub(super) exit_code: i32,
    pub(super) stderr: String,
}

pub(super) struct GitOutput {
    pub(super) exit_code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

pub(super) struct GitDiffCapture {
    pub(super) exit_code: i32,
    pub(super) text: String,
    pub(super) truncated: bool,
    pub(super) stderr: String,
}
