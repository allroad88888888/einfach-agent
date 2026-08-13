//! 锁内一次性读到的写前旧内容，供守卫、journal 与 diff 共用。

use super::limits::MAX_BYTES;
use std::{fs, path::Path};

/// Previous on-disk content, read once inside the path lock and then shared by
/// the optimistic guard, the rollback journal, and the change summary.
pub(super) enum BeforeContent {
    Missing,
    Text(String),
    /// Present but not representable as reversible UTF-8 text; carries the reason
    /// so guard/journal callers can fail with the same message as before.
    Unsupported(String),
}

impl BeforeContent {
    pub(super) fn existed(&self) -> bool {
        !matches!(self, BeforeContent::Missing)
    }

    pub(super) fn text(&self) -> Option<&str> {
        match self {
            BeforeContent::Text(value) => Some(value.as_str()),
            _ => None,
        }
    }
}

/// Read the current content once for the guard, the journal and the diff.
///
/// Unreadable-but-present files are reported as `Unsupported` rather than as an
/// error: only callers that actually need the old bytes (an optimistic guard, or
/// a journaled write that must stay reversible) reject them, so a plain overwrite
/// of a large or binary file keeps working and merely loses its change summary.
pub(super) fn read_before_content(path: &Path) -> BeforeContent {
    let Ok(metadata) = fs::metadata(path) else {
        return BeforeContent::Missing;
    };
    if !metadata.is_file() {
        return BeforeContent::Unsupported("rollback only supports regular files".to_string());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return BeforeContent::Unsupported(format!(
            "existing file exceeds reversible {MAX_BYTES} byte limit"
        ));
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return BeforeContent::Unsupported(format!("failed to read file for rollback: {error}"))
        }
    };
    if bytes.contains(&0) {
        return BeforeContent::Unsupported("binary files are not reversible".to_string());
    }
    match String::from_utf8(bytes) {
        Ok(text) => BeforeContent::Text(text),
        Err(_) => BeforeContent::Unsupported("non-UTF-8 files are not reversible".to_string()),
    }
}
