//! 模型可下发的补丁操作定义，以及操作名/路径的投影。

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PatchOperation {
    AddFile {
        path: String,
        content: String,
        /// Set the executable bit on the created file. Unix only.
        executable: Option<bool>,
    },
    DeleteFile {
        path: String,
        #[serde(rename = "oldContent")]
        old_content: Option<String>,
        /// Hash form of `oldContent`, matching write_file's guard of the same name.
        #[serde(rename = "expectedContentHash")]
        expected_content_hash: Option<String>,
    },
    Replace {
        path: String,
        #[serde(rename = "oldText")]
        old_text: String,
        #[serde(rename = "newText")]
        new_text: String,
        #[serde(rename = "expectedReplacements")]
        expected_replacements: Option<i64>,
    },
    OverwriteFile {
        path: String,
        content: String,
        #[serde(rename = "oldContent")]
        old_content: Option<String>,
        /// Hash form of `oldContent`. Overwriting an existing file requires one of the
        /// two; the hash avoids resending the whole previous file just to prove it was read.
        #[serde(rename = "expectedContentHash")]
        expected_content_hash: Option<String>,
        executable: Option<bool>,
    },
}

pub(super) fn operation_name(operation: &PatchOperation) -> &'static str {
    match operation {
        PatchOperation::AddFile { .. } => "add_file",
        PatchOperation::DeleteFile { .. } => "delete_file",
        PatchOperation::Replace { .. } => "replace",
        PatchOperation::OverwriteFile { .. } => "overwrite_file",
    }
}

pub(super) fn operation_path(operation: &PatchOperation) -> &str {
    match operation {
        PatchOperation::AddFile { path, .. }
        | PatchOperation::DeleteFile { path, .. }
        | PatchOperation::Replace { path, .. }
        | PatchOperation::OverwriteFile { path, .. } => path,
    }
}
