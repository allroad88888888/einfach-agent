//! workspace 变更日志的条目与回滚结果数据模型。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeContext {
    pub change_id: String,
    pub session_id: String,
    pub run_id: String,
    pub tool_call_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeSummary {
    pub id: String,
    pub reversible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ChangeStatus {
    Prepared,
    Applied,
    Reverted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileSnapshot {
    exists: bool,
    hash: Option<String>,
    pub(super) content: Option<String>,
}

impl FileSnapshot {
    pub(super) fn from_content(content: Option<String>) -> Self {
        let hash = content.as_ref().map(|value| {
            let mut hasher = Sha256::new();
            hasher.update(value.as_bytes());
            format!("{:x}", hasher.finalize())
        });
        Self {
            exists: content.is_some(),
            hash,
            content,
        }
    }

    pub(super) fn same_state(&self, other: &Self) -> bool {
        self.exists == other.exists && self.hash == other.hash
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChangedFile {
    pub(super) path: String,
    pub(super) before: FileSnapshot,
    pub(super) after: FileSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MovedPath {
    pub(super) path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TrackedPath {
    pub(super) path: String,
    pub(super) fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelocatedPath {
    pub(super) source: String,
    pub(super) destination: String,
    pub(super) fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceChangeSet {
    pub(super) id: String,
    pub(super) session_id: String,
    pub(super) run_id: String,
    pub(super) tool_call_id: String,
    pub(super) workspace_root: String,
    pub(super) created_at: u128,
    pub(super) status: ChangeStatus,
    #[serde(default)]
    pub(super) files: Vec<ChangedFile>,
    #[serde(default)]
    pub(super) moved_paths: Vec<MovedPath>,
    #[serde(default)]
    pub(super) created_paths: Vec<TrackedPath>,
    #[serde(default)]
    pub(super) relocated_paths: Vec<RelocatedPath>,
}

#[derive(Clone, Debug)]
pub struct ChangeFileInput {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeConflict {
    pub(super) path: String,
    pub(super) reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRevertResult {
    pub ok: bool,
    pub status: String,
    pub restored_files: Vec<String>,
    pub conflicts: Vec<WorkspaceChangeConflict>,
    pub error: Option<String>,
    pub reverted_change_set_ids: Vec<String>,
}

pub(super) fn error_result(status: &str, error: impl Into<String>) -> WorkspaceRevertResult {
    WorkspaceRevertResult {
        ok: false,
        status: status.to_string(),
        restored_files: Vec::new(),
        conflicts: Vec::new(),
        error: Some(error.into()),
        reverted_change_set_ids: Vec::new(),
    }
}
