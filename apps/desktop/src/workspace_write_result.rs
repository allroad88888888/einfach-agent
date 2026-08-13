//! 写入命令回给前端的结果结构，以及结构化失败的构造入口。

use crate::workspace_change_journal::WorkspaceChangeSummary;
use crate::workspace_common::FileChangeSummary;
use serde::Serialize;

#[derive(Serialize)]
pub struct WorkspaceWriteResult {
    pub(super) ok: bool,
    pub(super) path: String,
    pub(super) bytes_written: usize,
    pub(super) created: bool,
    pub(super) overwritten: bool,
    pub(super) appended: bool,
    pub(super) error: Option<String>,
    pub(super) change_set: Option<WorkspaceChangeSummary>,
    /// What actually changed on disk, so the caller does not have to re-read the
    /// file to confirm the edit. Absent when the previous content was unreadable.
    pub(super) change_summary: Option<FileChangeSummary>,
    /// Whether this write produced a rollback entry. Binary content and files past
    /// the reversible budget still get written — they just cannot be reverted, and
    /// say so rather than failing outright.
    pub(super) reversible: bool,
    /// Why the write is not reversible. Only set when `reversible` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reversible_reason: Option<String>,
    /// True when `dry_run` was requested: nothing was written, and the other fields
    /// describe what a real write would have done.
    pub(super) dry_run: bool,
    pub(super) would_change: bool,
}

pub(super) fn error_result(path: &str, error: impl Into<String>) -> WorkspaceWriteResult {
    WorkspaceWriteResult {
        ok: false,
        path: path.to_string(),
        bytes_written: 0,
        created: false,
        overwritten: false,
        appended: false,
        error: Some(error.into()),
        change_set: None,
        change_summary: None,
        reversible: false,
        reversible_reason: None,
        dry_run: false,
        would_change: false,
    }
}
