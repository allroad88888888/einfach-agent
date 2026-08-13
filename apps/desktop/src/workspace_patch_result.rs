//! 补丁命令回给前端的结果结构。

use crate::workspace_change_journal::WorkspaceChangeSummary;
use crate::workspace_common::FileChangeSummary;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchResult {
    pub(super) ok: bool,
    pub(super) changed_files: Vec<String>,
    /// Per-file line counts and diffs, in the same shape write_file returns, so the
    /// caller can confirm the edit without re-reading every touched file.
    pub(super) changes: Vec<PatchFileChange>,
    pub(super) rejected: Vec<RejectedOperation>,
    pub(super) dry_run: bool,
    pub(super) would_change: bool,
    pub(super) summary: String,
    pub(super) change_set: Option<WorkspaceChangeSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchFileChange {
    pub(super) path: String,
    pub(super) created: bool,
    pub(super) deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) change_summary: Option<FileChangeSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedOperation {
    pub(super) index: usize,
    pub(super) operation: String,
    pub(super) path: Option<String>,
    pub(super) reason: String,
}
