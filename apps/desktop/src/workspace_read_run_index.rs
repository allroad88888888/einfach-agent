//! runs.jsonl 归档索引的尾向前分页与快照游标校验。

use super::content::reject_binary_bytes;
use super::limits::{
    normalize_positive, DEFAULT_RUN_INDEX_PAGE_RECORDS, MAX_RUN_INDEX_BYTES,
    MAX_RUN_INDEX_PAGE_RECORDS, RUNS_INDEX_PATH,
};
use super::paths::{display_path, resolve_workspace_path};
use super::types::{ReadWorkspaceRunIndexPageResult, WorkspaceJsonlLine};
use crate::workspace_common::resolve_workspace_root;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::Read,
};

fn run_index_snapshot(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("v1-{}-{:016x}", bytes.len(), hasher.finish())
}

fn parse_run_index_cursor(cursor: &str) -> Result<(&str, usize), String> {
    let (snapshot, before) = cursor
        .rsplit_once(':')
        .ok_or_else(|| "run index cursor is invalid; refresh history".to_string())?;
    if !snapshot.starts_with("v1-") {
        return Err("run index cursor version is unsupported; refresh history".to_string());
    }
    let before = before
        .parse::<usize>()
        .map_err(|_| "run index cursor is invalid; refresh history".to_string())?;
    Ok((snapshot, before))
}

pub(super) fn read_workspace_run_index_page_blocking(
    cursor: Option<String>,
    max_records: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceRunIndexPageResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let file_path = resolve_workspace_path(&root, RUNS_INDEX_PATH, false)?;
    let metadata = fs::metadata(&file_path).map_err(|err| {
        format!(
            "file `{}` is not accessible: {err}",
            display_path(&file_path)
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("path `{}` is not a file", display_path(&file_path)));
    }
    if metadata.len() > MAX_RUN_INDEX_BYTES as u64 {
        return Err(format!(
            "run index exceeds the {} byte safety limit; compact the index first",
            MAX_RUN_INDEX_BYTES
        ));
    }

    let mut file = File::open(&file_path)
        .map_err(|err| format!("failed to open `{}`: {err}", display_path(&file_path)))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read `{}`: {err}", display_path(&file_path)))?;
    if bytes.len() > MAX_RUN_INDEX_BYTES {
        return Err(format!(
            "run index exceeds the {} byte safety limit; compact the index first",
            MAX_RUN_INDEX_BYTES
        ));
    }
    reject_binary_bytes(&bytes, &file_path)?;
    let content = std::str::from_utf8(&bytes).map_err(|_| {
        format!(
            "refusing to read non-UTF-8 file `{}`",
            display_path(&file_path)
        )
    })?;
    let snapshot = run_index_snapshot(&bytes);
    let all_lines: Vec<&str> = content.lines().collect();
    let before = if let Some(cursor) = cursor.as_deref() {
        let (expected_snapshot, before) = parse_run_index_cursor(cursor)?;
        if expected_snapshot != snapshot {
            return Err("run index changed while paging; refresh history".to_string());
        }
        if before > all_lines.len() {
            return Err("run index cursor is out of range; refresh history".to_string());
        }
        before
    } else {
        all_lines.len()
    };
    let max_records = normalize_positive(
        max_records,
        DEFAULT_RUN_INDEX_PAGE_RECORDS,
        MAX_RUN_INDEX_PAGE_RECORDS,
    );
    let mut lines = Vec::with_capacity(max_records);
    let mut next_before = before;
    for index in (0..before).rev() {
        next_before = index;
        if all_lines[index].trim().is_empty() {
            continue;
        }
        lines.push(WorkspaceJsonlLine {
            line_number: index + 1,
            content: all_lines[index].to_string(),
        });
        if lines.len() == max_records {
            break;
        }
    }
    let has_more = all_lines[..next_before]
        .iter()
        .any(|line| !line.trim().is_empty());
    let cursor = has_more.then(|| format!("{snapshot}:{next_before}"));

    Ok(ReadWorkspaceRunIndexPageResult {
        path: RUNS_INDEX_PATH.to_string(),
        lines,
        cursor,
        has_more,
        snapshot,
    })
}

#[cfg(test)]
#[path = "workspace_read_run_index_tests.rs"]
mod tests;
