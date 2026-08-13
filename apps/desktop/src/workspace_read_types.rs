//! workspace 读取命令返回给前端的序列化结果类型。

use serde::Serialize;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileResult {
    pub(super) path: String,
    pub(super) content: String,
    pub(super) truncated: bool,
    pub(super) bytes: usize,
    pub(super) offset: u64,
    pub(super) total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) content_hash: Option<String>,
    /// 行定位模式下本段第一行的行号（1-based）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) start_line: Option<usize>,
    /// 行定位模式下本段最后一行的行号（1-based，含）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) end_line: Option<usize>,
    /// 仍有后续行时给出，直接作为下一次的 startLine。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next_line: Option<usize>,
    /// 文件总行数；行定位模式下总是给出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) total_lines: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceJsonlLine {
    pub(super) line_number: usize,
    pub(super) content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceRunIndexPageResult {
    pub(super) path: String,
    pub(super) lines: Vec<WorkspaceJsonlLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cursor: Option<String>,
    pub(super) has_more: bool,
    pub(super) snapshot: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub(super) path: String,
    #[serde(rename = "type")]
    pub(super) entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceFilesResult {
    pub(super) entries: Vec<WorkspaceFileEntry>,
    pub(super) truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchMatch {
    pub(super) path: String,
    pub(super) line: String,
    pub(super) line_number: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWorkspaceFilesResult {
    pub(super) matches: Vec<WorkspaceSearchMatch>,
    pub(super) truncated: bool,
}
