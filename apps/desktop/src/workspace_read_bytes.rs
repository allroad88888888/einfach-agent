//! read_file 的字节偏移分段读取与整文件哈希策略。

use super::content::{content_sha256, decode_utf8, reject_binary_bytes};
use super::limits::{
    normalize_positive, DEFAULT_READ_MAX_BYTES, MAX_HASH_BYTES, MAX_READ_BYTES,
    MAX_TRACE_READ_BYTES,
};
use super::paths::{display_path, relative_path, resolve_workspace_path};
use super::types::ReadWorkspaceFileResult;
use crate::workspace_common::resolve_workspace_root;
use std::{
    fs,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

#[cfg(test)]
pub(super) fn read_workspace_file_blocking(
    path: String,
    max_bytes: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_blocking_with_access_at(path, max_bytes, None, workspace_root, false)
}

#[cfg(test)]
pub(super) fn read_workspace_file_blocking_with_access(
    path: String,
    max_bytes: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_blocking_with_access_at(
        path,
        max_bytes,
        None,
        workspace_root,
        allow_external_paths,
    )
}

pub(super) fn read_workspace_file_blocking_with_access_at(
    path: String,
    max_bytes: Option<usize>,
    offset: Option<u64>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<ReadWorkspaceFileResult, String> {
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
    let offset = offset.unwrap_or(0);
    if offset > total_bytes {
        return Err(format!(
            "offset {offset} exceeds file size {total_bytes} for `{}`",
            display_path(&file_path)
        ));
    }

    let relative_file_path = file_path.strip_prefix(&root).unwrap_or(&file_path);
    let read_ceiling = if relative_file_path.starts_with(Path::new(".webAgent-archive/traces"))
        && relative_file_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".trace.jsonl"))
    {
        MAX_TRACE_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    let max_bytes = normalize_positive(max_bytes, DEFAULT_READ_MAX_BYTES, read_ceiling);
    let mut file = File::open(&file_path)
        .map_err(|err| format!("failed to open `{}`: {err}", display_path(&file_path)))?;
    file.seek(SeekFrom::Start(offset)).map_err(|err| {
        format!(
            "failed to seek `{}` to {offset}: {err}",
            display_path(&file_path)
        )
    })?;
    // 乐观锁需要的是【整个文件】的哈希，不是本段的。之前只在「一次读完」时才给，于是任何
    // 超过 max_bytes 的文件都永远拿不到 contentHash，只能裸覆盖——而大文件恰恰最该防并发修改。
    //
    // 起始段读取时把整个文件一次读入来算它：分两次读（一次取内容、一次算哈希）会让 content
    // 与 contentHash 可能对应到不同的文件版本，guard 通过了但模型看到的并不是那一版。
    let hash_whole_file = offset == 0 && total_bytes <= MAX_HASH_BYTES;
    let mut bytes = Vec::new();
    let mut content_hash = None;
    if hash_whole_file {
        // take 是竞态兜底：metadata 之后文件可能变大，读入量仍要卡住上限。
        file.by_ref()
            .take(MAX_HASH_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("failed to read `{}`: {err}", display_path(&file_path)))?;
        if bytes.len() as u64 <= MAX_HASH_BYTES {
            content_hash = Some(content_sha256(&bytes));
        }
    } else {
        file.by_ref()
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("failed to read `{}`: {err}", display_path(&file_path)))?;
    }

    let buffer_truncated = bytes.len() > max_bytes;
    if buffer_truncated {
        bytes.truncate(max_bytes);
    }
    // 二进制与 UTF-8 判定仍然只针对返回的这一段，避免文件尾部的非文本内容让一次合法的
    // 首段读取整体失败。
    reject_binary_bytes(&bytes, &file_path)?;
    let content = decode_utf8(&bytes, buffer_truncated, &file_path)?;
    let bytes = content.as_bytes().len();
    let next_position = offset + bytes as u64;
    let truncated = next_position < total_bytes;
    let next_offset = truncated.then_some(next_position);

    Ok(ReadWorkspaceFileResult {
        path: relative_path(&root, &file_path),
        content,
        truncated,
        bytes,
        offset,
        total_bytes,
        next_offset,
        content_hash,
        // 字节模式不报行号：算出本段起始行要先扫过它前面的全部内容，而这条路径存在的
        // 意义正是不必读整个文件。需要行号就用 startLine。
        start_line: None,
        end_line: None,
        next_line: None,
        total_lines: None,
    })
}

#[cfg(test)]
#[path = "workspace_read_bytes_tests.rs"]
mod tests;
