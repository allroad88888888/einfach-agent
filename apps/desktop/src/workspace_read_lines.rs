//! read_file 的行定位读取：按 startLine / lineCount 返回完整行。

use super::content::{content_sha256, decode_utf8, reject_binary_bytes};
use super::limits::{normalize_positive, DEFAULT_READ_MAX_BYTES, MAX_HASH_BYTES, MAX_READ_BYTES};
use super::paths::{display_path, relative_path, resolve_workspace_path};
use super::types::ReadWorkspaceFileResult;
use crate::workspace_common::resolve_workspace_root;
use std::fs;

/// 按行定位读取。模型拿到的行号来自 rg_search / 编译错误 / diff，字节偏移接不上它们；
/// 这条路径让「读第 342 行附近」成为一次直接调用，而不是整段读回来自己数行。
pub(super) fn read_workspace_file_lines(
    path: String,
    max_bytes: Option<usize>,
    start_line: usize,
    line_count: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<ReadWorkspaceFileResult, String> {
    if start_line == 0 {
        return Err("startLine is 1-based; use 1 for the first line".to_string());
    }
    if line_count == Some(0) {
        return Err("lineCount must be greater than 0".to_string());
    }

    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let requested = path.trim();
    if requested.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }
    let file_path = resolve_workspace_path(&root, requested, allow_external_paths)?;
    let metadata = fs::metadata(&file_path).map_err(|err| {
        format!(
            "file `{}` is not accessible: {err}",
            display_path(&file_path)
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("path `{}` is not a file", display_path(&file_path)));
    }
    let total_bytes = metadata.len();
    // 定位第 N 行必须先看过它前面的所有字节，所以行模式按整文件读入；再大的文件退回
    // offset 分段。
    if total_bytes > MAX_HASH_BYTES {
        return Err(format!(
            "file `{}` is {total_bytes} bytes, too large for line addressing; read it in byte \
             chunks with offset/nextOffset instead",
            display_path(&file_path)
        ));
    }

    let raw = fs::read(&file_path)
        .map_err(|err| format!("failed to read `{}`: {err}", display_path(&file_path)))?;
    reject_binary_bytes(&raw, &file_path)?;
    let text = decode_utf8(&raw, false, &file_path)?;
    let content_hash = content_sha256(text.as_bytes());

    // split_inclusive 保留每行原本的行尾，因此拼回去与磁盘逐字节一致——CRLF 文件读出来
    // 不会被悄悄改成 LF，这段内容可以直接当作 apply_patch 的 oldText 使用。
    let segments: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = segments.len();
    if start_line > total_lines {
        return Err(format!(
            "startLine {start_line} exceeds the file's {total_lines} line(s) in `{}`",
            display_path(&file_path)
        ));
    }

    let byte_ceiling = normalize_positive(max_bytes, DEFAULT_READ_MAX_BYTES, MAX_READ_BYTES);
    let first_index = start_line - 1;
    let requested_last = line_count
        .map(|count| (first_index + count).min(total_lines))
        .unwrap_or(total_lines);

    // maxBytes 仍是硬约束，但按行读就按整行截断：返回半行会让内容无法用作 oldText。
    let mut collected = String::new();
    let mut end_index = first_index;
    for segment in &segments[first_index..requested_last] {
        if !collected.is_empty() && collected.len() + segment.len() > byte_ceiling {
            break;
        }
        collected.push_str(segment);
        end_index += 1;
        if collected.len() >= byte_ceiling {
            break;
        }
    }

    let byte_offset: usize = segments[..first_index]
        .iter()
        .map(|segment| segment.len())
        .sum();
    let served_all = end_index >= total_lines;
    let bytes = collected.len();
    Ok(ReadWorkspaceFileResult {
        path: relative_path(&root, &file_path),
        content: collected,
        truncated: !served_all,
        bytes,
        offset: byte_offset as u64,
        total_bytes,
        next_offset: (!served_all).then_some((byte_offset + bytes) as u64),
        // 起始行读取等价于从头读，此时哈希与字节模式的首段语义一致。
        content_hash: (start_line == 1).then_some(content_hash),
        start_line: Some(start_line),
        end_line: Some(end_index),
        next_line: (!served_all).then_some(end_index + 1),
        total_lines: Some(total_lines),
    })
}

#[cfg(test)]
#[path = "workspace_read_lines_tests.rs"]
mod tests;
