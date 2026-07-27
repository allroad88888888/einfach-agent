use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf, MAIN_SEPARATOR},
};

const DEFAULT_READ_MAX_BYTES: usize = 20_000;
const MAX_READ_BYTES: usize = 200_000;
// contentHash 的唯一用途是给 write_file / apply_patch 当乐观锁，所以只对它们真的能整体
// 覆盖的大小计算——上限对齐 write_file。更大的文件即使给出哈希也没有工具能用它做覆盖，
// 白扫一遍全文没有意义。
const MAX_HASH_BYTES: u64 = 8 * 1024 * 1024;
// 完整轨迹只在选中单个子 agent 时读取，因此仅对归档轨迹目录放宽显式读取上限。
const MAX_TRACE_READ_BYTES: usize = 2_000_000;
const DEFAULT_RUN_INDEX_PAGE_RECORDS: usize = 50;
const MAX_RUN_INDEX_PAGE_RECORDS: usize = 500;
const MAX_RUN_INDEX_BYTES: usize = 16 * 1024 * 1024;
const RUNS_INDEX_PATH: &str = ".agent-archive/index/runs.jsonl";
const DEFAULT_LIST_MAX_ENTRIES: usize = 200;
const MAX_LIST_ENTRIES: usize = 2_000;
const DEFAULT_SEARCH_MAX_MATCHES: usize = 100;
const MAX_SEARCH_MATCHES: usize = 1_000;
const MAX_SEARCH_FILE_BYTES: usize = 1_000_000;
const MAX_SEARCH_LINE_CHARS: usize = 1_000;
// P2 搜索遍历预算：query 少/无匹配时 max_matches 永不触发，会遍历整棵树（node_modules/target）
// 独占 blocking worker。扫描的目录条目数达此上限即停并置 truncated。
const MAX_SEARCH_SCANNED_ENTRIES: usize = 20_000;
// P2 排除常见重目录：整个跳过、不递归进去（.git/.next 等隐藏目录本就被 is_hidden 跳过，
// 这里再显式列一遍并覆盖 node_modules/target/dist 等非隐藏的重目录）。
const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileResult {
    path: String,
    content: String,
    truncated: bool,
    bytes: usize,
    offset: u64,
    total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceJsonlLine {
    line_number: usize,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceRunIndexPageResult {
    path: String,
    lines: Vec<WorkspaceJsonlLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    has_more: bool,
    snapshot: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceFilesResult {
    entries: Vec<WorkspaceFileEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchMatch {
    path: String,
    line: String,
    line_number: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWorkspaceFilesResult {
    matches: Vec<WorkspaceSearchMatch>,
    truncated: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn read_workspace_file(
    path: String,
    max_bytes: Option<usize>,
    offset: Option<u64>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<ReadWorkspaceFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_blocking_with_access_at(
            path,
            max_bytes,
            offset,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("read_workspace_file worker failed: {err}"))?
}

/// 从 runs.jsonl 文件尾向前稳定分页。cursor 绑定完整文件内容 fingerprint；append、压缩或
/// 替换发生后旧 cursor 会显式失效，前端不能把两个索引版本静默拼接。
#[tauri::command(rename_all = "snake_case")]
pub async fn read_workspace_run_index_page(
    cursor: Option<String>,
    max_records: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceRunIndexPageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_run_index_page_blocking(cursor, max_records, workspace_root)
    })
    .await
    .map_err(|err| format!("read_workspace_run_index_page worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_workspace_files(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<ListWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_files_blocking_with_access(
            path,
            recursive,
            max_entries,
            include_hidden,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("list_workspace_files worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn search_workspace_files(
    query: String,
    path: Option<String>,
    glob: Option<String>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<SearchWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_files_blocking_with_access(
            query,
            path,
            glob,
            max_matches,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("search_workspace_files worker failed: {err}"))?
}

#[cfg(test)]
fn read_workspace_file_blocking(
    path: String,
    max_bytes: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_blocking_with_access_at(path, max_bytes, None, workspace_root, false)
}

#[cfg(test)]
fn read_workspace_file_blocking_with_access(
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

fn read_workspace_file_blocking_with_access_at(
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
    let read_ceiling = if relative_file_path.starts_with(Path::new(".agent-archive/traces"))
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
    })
}

fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

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

fn read_workspace_run_index_page_blocking(
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
fn list_workspace_files_blocking(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
) -> Result<ListWorkspaceFilesResult, String> {
    list_workspace_files_blocking_with_access(
        path,
        recursive,
        max_entries,
        include_hidden,
        workspace_root,
        false,
    )
}

fn list_workspace_files_blocking_with_access(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<ListWorkspaceFilesResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let requested = optional_path_or_default(path.as_deref(), ".");
    let dir = resolve_workspace_path(&root, requested, allow_external_paths)?;
    let metadata = fs::metadata(&dir)
        .map_err(|err| format!("path `{}` is not accessible: {err}", display_path(&dir)))?;
    if !metadata.is_dir() {
        return Err(format!("path `{}` is not a directory", display_path(&dir)));
    }

    let recursive = recursive.unwrap_or(false);
    let include_hidden = include_hidden.unwrap_or(false);
    let max_entries = normalize_positive(max_entries, DEFAULT_LIST_MAX_ENTRIES, MAX_LIST_ENTRIES);
    let mut entries = Vec::new();
    let mut truncated = false;

    collect_entries(
        &root,
        &dir,
        recursive,
        include_hidden,
        max_entries,
        allow_external_paths,
        &mut entries,
        &mut truncated,
    )?;

    Ok(ListWorkspaceFilesResult { entries, truncated })
}

#[cfg(test)]
fn search_workspace_files_blocking(
    query: String,
    path: Option<String>,
    glob: Option<String>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
) -> Result<SearchWorkspaceFilesResult, String> {
    search_workspace_files_blocking_with_access(
        query,
        path,
        glob,
        max_matches,
        workspace_root,
        false,
    )
}

fn search_workspace_files_blocking_with_access(
    query: String,
    path: Option<String>,
    glob: Option<String>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<SearchWorkspaceFilesResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query (non-empty string) is required".to_string());
    }

    let requested = optional_path_or_default(path.as_deref(), ".");
    let target = resolve_workspace_path(&root, requested, allow_external_paths)?;
    let metadata = fs::metadata(&target)
        .map_err(|err| format!("path `{}` is not accessible: {err}", display_path(&target)))?;
    let glob = glob.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let max_matches =
        normalize_positive(max_matches, DEFAULT_SEARCH_MAX_MATCHES, MAX_SEARCH_MATCHES);
    let mut matches = Vec::new();
    let mut truncated = false;
    // P2 遍历预算：跨整棵递归共享的已扫描条目计数，耗尽即停（置 truncated）。
    let mut scanned = 0usize;

    if metadata.is_file() {
        maybe_search_file(
            &root,
            &target,
            &query,
            glob.as_deref(),
            max_matches,
            &mut matches,
            &mut truncated,
        )?;
    } else if metadata.is_dir() {
        collect_search_matches(
            &root,
            &target,
            &query,
            glob.as_deref(),
            max_matches,
            allow_external_paths,
            &mut scanned,
            &mut matches,
            &mut truncated,
        )?;
    } else {
        return Err(format!(
            "path `{}` is neither a file nor a directory",
            display_path(&target)
        ));
    }

    Ok(SearchWorkspaceFilesResult { matches, truncated })
}

fn optional_path_or_default<'a>(path: Option<&'a str>, default_path: &'a str) -> &'a str {
    match path {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => default_path,
    }
}

fn resolve_workspace_path(
    root: &Path,
    requested: &str,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    let requested_path = PathBuf::from(requested);
    let joined = if requested_path.is_absolute() {
        requested_path
    } else {
        root.join(requested_path)
    };
    // confirm 模式：绝对路径也先 canonicalize（解析符号链接/`..`），再校验 starts_with(root)。
    // Auto 模式由宿主传入 runtime-only allow_external_paths，可读取 canonicalize 后的外部目标。
    let resolved = fs::canonicalize(&joined).map_err(|err| {
        format!(
            "path `{}` is not accessible in workspace `{}`: {err}",
            requested,
            display_path(root)
        )
    })?;

    if !allow_external_paths && !resolved.starts_with(root) {
        return Err(format!(
            "path `{}` escapes workspace root `{}`",
            requested,
            display_path(root)
        ));
    }

    Ok(resolved)
}

fn normalize_positive(value: Option<usize>, fallback: usize, max: usize) -> usize {
    match value {
        Some(value) if value > 0 => value.min(max),
        _ => fallback,
    }
}

fn collect_entries(
    root: &Path,
    dir: &Path,
    recursive: bool,
    include_hidden: bool,
    max_entries: usize,
    allow_external_paths: bool,
    entries: &mut Vec<WorkspaceFileEntry>,
    truncated: &mut bool,
) -> Result<(), String> {
    if *truncated {
        return Ok(());
    }

    for path in sorted_read_dir(dir)? {
        if !include_hidden && is_hidden(&path) {
            continue;
        }

        let resolved = match fs::canonicalize(&path) {
            Ok(resolved) => resolved,
            Err(_) => continue,
        };
        if !allow_external_paths && !resolved.starts_with(root) {
            continue;
        }

        if entries.len() >= max_entries {
            *truncated = true;
            return Ok(());
        }

        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        entries.push(to_entry(root, &path, &metadata));

        if recursive && metadata.is_dir() && !metadata.file_type().is_symlink() {
            collect_entries(
                root,
                &path,
                recursive,
                include_hidden,
                max_entries,
                allow_external_paths,
                entries,
                truncated,
            )?;
            if *truncated {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn collect_search_matches(
    root: &Path,
    dir: &Path,
    query: &str,
    glob: Option<&str>,
    max_matches: usize,
    allow_external_paths: bool,
    scanned: &mut usize,
    matches: &mut Vec<WorkspaceSearchMatch>,
    truncated: &mut bool,
) -> Result<(), String> {
    if matches.len() >= max_matches {
        *truncated = true;
        return Ok(());
    }

    for path in sorted_read_dir(dir)? {
        // P2 预算：扫描条目数达上限即停（无匹配时不再遍历整棵大树独占 worker）。
        if *scanned >= MAX_SEARCH_SCANNED_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        *scanned += 1;

        if is_hidden(&path) {
            continue;
        }

        let resolved = match fs::canonicalize(&path) {
            Ok(resolved) => resolved,
            Err(_) => continue,
        };
        if !allow_external_paths && !resolved.starts_with(root) {
            continue;
        }

        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            // P2 排除常见重目录（node_modules/target/dist...），整个跳过不递归。
            if is_excluded_dir(&path) {
                continue;
            }
            collect_search_matches(
                root,
                &path,
                query,
                glob,
                max_matches,
                allow_external_paths,
                scanned,
                matches,
                truncated,
            )?;
        } else if metadata.is_file() {
            maybe_search_file(root, &path, query, glob, max_matches, matches, truncated)?;
        }

        if matches.len() >= max_matches {
            *truncated = true;
            return Ok(());
        }
        // 子递归可能已耗尽预算，冒泡停止（下一轮 loop 顶部也会拦，这里提前收）。
        if *scanned >= MAX_SEARCH_SCANNED_ENTRIES {
            *truncated = true;
            return Ok(());
        }
    }

    Ok(())
}

fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| EXCLUDED_DIR_NAMES.contains(&name))
        .unwrap_or(false)
}

fn maybe_search_file(
    root: &Path,
    file_path: &Path,
    query: &str,
    glob: Option<&str>,
    max_matches: usize,
    matches: &mut Vec<WorkspaceSearchMatch>,
    truncated: &mut bool,
) -> Result<(), String> {
    let rel_path = relative_path(root, file_path);
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !matches_glob(&rel_path, file_name, glob) {
        return Ok(());
    }

    let mut file = File::open(file_path)
        .map_err(|err| format!("failed to open `{}`: {err}", display_path(file_path)))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_SEARCH_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read `{}`: {err}", display_path(file_path)))?;

    let file_truncated = bytes.len() > MAX_SEARCH_FILE_BYTES;
    if file_truncated {
        bytes.truncate(MAX_SEARCH_FILE_BYTES);
        *truncated = true;
    }
    if reject_binary_bytes(&bytes, file_path).is_err() {
        return Ok(());
    }

    let content = match decode_utf8(&bytes, file_truncated, file_path) {
        Ok(content) => content,
        Err(_) => return Ok(()),
    };

    for (index, line) in content.lines().enumerate() {
        if line.contains(query) {
            matches.push(WorkspaceSearchMatch {
                path: rel_path.clone(),
                line: cap_chars(line, MAX_SEARCH_LINE_CHARS),
                line_number: index + 1,
            });
            if matches.len() >= max_matches {
                *truncated = true;
                return Ok(());
            }
        }
    }

    Ok(())
}

fn sorted_read_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let read_dir = fs::read_dir(dir)
        .map_err(|err| format!("failed to read directory `{}`: {err}", display_path(dir)))?;
    for entry in read_dir {
        let entry = entry.map_err(|err| {
            format!(
                "failed to read directory entry in `{}`: {err}",
                display_path(dir)
            )
        })?;
        paths.push(entry.path());
    }
    paths.sort_by(|a, b| relative_sort_key(a).cmp(&relative_sort_key(b)));
    Ok(paths)
}

fn relative_sort_key(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn to_entry(root: &Path, path: &Path, metadata: &fs::Metadata) -> WorkspaceFileEntry {
    let file_type = metadata.file_type();
    let entry_type = if file_type.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };

    WorkspaceFileEntry {
        path: relative_path(root, path),
        entry_type: entry_type.to_string(),
        size: if metadata.is_file() {
            Some(metadata.len())
        } else {
            None
        },
    }
}

fn matches_glob(rel_path: &str, file_name: &str, glob: Option<&str>) -> bool {
    let Some(pattern) = glob else {
        return true;
    };
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }

    if let Some(suffix) = pattern.strip_prefix('*') {
        return rel_path.ends_with(suffix) || file_name.ends_with(suffix);
    }
    if pattern.starts_with('.') {
        return rel_path.ends_with(pattern) || file_name.ends_with(pattern);
    }
    if pattern.contains('*') {
        let needle = pattern.replace('*', "");
        return needle.is_empty() || rel_path.contains(&needle) || file_name.contains(&needle);
    }

    rel_path.contains(pattern) || file_name.contains(pattern)
}

fn reject_binary_bytes(bytes: &[u8], path: &Path) -> Result<(), String> {
    if bytes.iter().any(|byte| *byte == 0) {
        return Err(format!(
            "refusing to read binary file `{}`",
            display_path(path)
        ));
    }
    Ok(())
}

fn decode_utf8(bytes: &[u8], allow_incomplete_tail: bool, path: &Path) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(value) => Ok(value.to_string()),
        Err(err) if allow_incomplete_tail && err.error_len().is_none() => {
            Ok(String::from_utf8_lossy(&bytes[..err.valid_up_to()]).into_owned())
        }
        Err(_) => Err(format!(
            "refusing to read non-UTF-8 file `{}`",
            display_path(path)
        )),
    }
}

fn cap_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect()
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.starts_with('.') && name != "." && name != "..")
        .unwrap_or(false)
}

fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    path_to_slash_string(relative)
}

fn display_path(path: &Path) -> String {
    path_to_slash_string(path)
}

fn path_to_slash_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    if MAIN_SEPARATOR == '/' {
        text.into_owned()
    } else {
        text.replace(MAIN_SEPARATOR, "/")
    }
}

#[cfg(test)]
mod tests {
    // 真读磁盘的集成测试：用 fs::write 造真文件，显式把该目录作为 workspace_root 传入 *_blocking，
    // 验证 read/list/search 真读到内容，以及 confine（../、workspace 外绝对路径、文件系统根 `/`）在真实路径下被拒。
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // 返回 (base, workspace)：base 唯一且 canonicalize；workspace = base/ws 也 canonicalize
    //（满足 resolve_workspace_path 的 starts_with(root) 校验）。base 用于放 workspace 外的"越界目标"文件。
    fn unique_workspace() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut base = std::env::temp_dir();
        base.push(format!("ws_read_it_{}_{}", std::process::id(), seq));
        fs::create_dir_all(&base).expect("create base");
        let base = fs::canonicalize(&base).expect("canonicalize base");
        let ws = base.join("ws");
        fs::create_dir_all(&ws).expect("create ws");
        let ws = fs::canonicalize(&ws).expect("canonicalize ws");
        (base, ws)
    }

    fn root_arg(ws: &Path) -> Option<String> {
        Some(ws.to_string_lossy().into_owned())
    }

    #[test]
    fn read_file_returns_content() {
        // read_file 读回磁盘上真实文件的完整内容，path 为 workspace 相对。
        let (base, ws) = unique_workspace();
        fs::write(ws.join("notes.txt"), "hello read world").expect("seed file");

        let result = read_workspace_file_blocking("notes.txt".to_string(), None, root_arg(&ws))
            .expect("read should succeed");
        assert_eq!(result.content, "hello read world");
        assert!(!result.truncated);
        assert_eq!(
            result.content_hash,
            Some(content_sha256(b"hello read world"))
        );
        assert_eq!(result.path, "notes.txt", "path 应为 workspace 相对路径");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn read_file_supports_lossless_byte_offset_paging() {
        let (base, ws) = unique_workspace();
        let content = "ab你cd";
        fs::write(ws.join("paged.txt"), content).expect("seed paged file");

        let first = read_workspace_file_blocking_with_access_at(
            "paged.txt".to_string(),
            Some(4),
            Some(0),
            root_arg(&ws),
            false,
        )
        .expect("first chunk");
        assert_eq!(first.content, "ab");
        assert_eq!(first.offset, 0);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.total_bytes, content.len() as u64);
        assert!(first.truncated);
        // 首段即使被截断也要给出【整文件】哈希：否则大文件永远拿不到 contentHash，
        // 只能裸覆盖。注意它必须等于整个文件的哈希，而不是本段 "ab" 的哈希。
        assert_eq!(
            first.content_hash,
            Some(content_sha256(content.as_bytes())),
            "首段应返回整文件哈希"
        );
        assert_ne!(
            first.content_hash,
            Some(content_sha256(b"ab")),
            "不能是本段内容的哈希"
        );

        let second = read_workspace_file_blocking_with_access_at(
            "paged.txt".to_string(),
            Some(4),
            first.next_offset,
            root_arg(&ws),
            false,
        )
        .expect("second chunk");
        assert_eq!(second.content, "你c");
        assert_eq!(second.offset, 2);
        assert_eq!(second.next_offset, Some(6));

        let third = read_workspace_file_blocking_with_access_at(
            "paged.txt".to_string(),
            Some(4),
            second.next_offset,
            root_arg(&ws),
            false,
        )
        .expect("third chunk");
        assert_eq!(third.content, "d");
        assert!(!third.truncated);
        assert_eq!(third.next_offset, None);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn content_hash_is_only_offered_on_the_opening_chunk() {
        // 续读段拿不到哈希是对的：它描述整个文件，只在「我正要开始读这个文件」时有意义，
        // 每段都重算一遍纯属浪费。
        let (base, ws) = unique_workspace();
        let content = "0123456789";
        fs::write(ws.join("paged.txt"), content).expect("seed");

        let tail = read_workspace_file_blocking_with_access_at(
            "paged.txt".to_string(),
            Some(4),
            Some(4),
            root_arg(&ws),
            false,
        )
        .expect("tail chunk");

        assert_eq!(tail.offset, 4);
        assert_eq!(tail.content_hash, None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn content_hash_is_skipped_past_the_writable_ceiling() {
        // 超过 write_file 上限的文件没有工具能整体覆盖，给出哈希也用不上，
        // 不值得为此把整个文件扫一遍。
        let (base, ws) = unique_workspace();
        let oversized = "y".repeat((MAX_HASH_BYTES + 1) as usize);
        fs::write(ws.join("huge.txt"), &oversized).expect("seed huge file");

        let result = read_workspace_file_blocking("huge.txt".to_string(), Some(64), root_arg(&ws))
            .expect("huge read should still succeed");

        assert!(result.truncated);
        assert_eq!(result.total_bytes, oversized.len() as u64);
        assert_eq!(result.content_hash, None, "超出可写上限不再计算哈希");
        assert_eq!(result.content.len(), 64, "内容本身照常按 maxBytes 返回");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn opening_chunk_hash_round_trips_as_a_write_guard() {
        // 这条锁的是端到端契约：read_file 首段给出的哈希，必须正是 write_file 覆盖
        // 该文件时校验的那一个。两边算法漂移会让大文件的乐观锁静默失效。
        let (base, ws) = unique_workspace();
        let content = "line one\nline two\n".repeat(20_000); // 远超单次读取上限
        fs::write(ws.join("big.txt"), &content).expect("seed");

        let first = read_workspace_file_blocking("big.txt".to_string(), Some(100), root_arg(&ws))
            .expect("opening chunk");
        assert!(first.truncated, "该文件必须触发截断，否则这个用例没测到点子上");

        let hash = first.content_hash.expect("opening chunk carries a hash");
        // write_file 侧对完整文件内容做同样计算。
        assert_eq!(hash, content_sha256(content.as_bytes()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn trace_read_has_a_scoped_larger_ceiling() {
        let (base, ws) = unique_workspace();
        let trace_dir = ws.join(".agent-archive/traces");
        fs::create_dir_all(&trace_dir).expect("mkdir traces");
        let content = "x".repeat(MAX_READ_BYTES + 10_000);
        fs::write(trace_dir.join("root-01.trace.jsonl"), &content).expect("seed trace");
        fs::write(ws.join("ordinary.txt"), &content).expect("seed ordinary file");

        let trace = read_workspace_file_blocking(
            ".agent-archive/traces/root-01.trace.jsonl".to_string(),
            Some(content.len()),
            root_arg(&ws),
        )
        .expect("trace read should succeed");
        assert_eq!(trace.content.len(), content.len());
        assert!(!trace.truncated);
        assert_eq!(trace.content_hash, Some(content_sha256(content.as_bytes())));

        let ordinary = read_workspace_file_blocking(
            "ordinary.txt".to_string(),
            Some(content.len()),
            root_arg(&ws),
        )
        .expect("ordinary read should succeed");
        assert_eq!(ordinary.content.len(), MAX_READ_BYTES);
        assert!(ordinary.truncated);
        // 被读取上限截断不影响哈希：它描述的是整个文件，正是覆盖这个文件时要传的 guard。
        assert_eq!(
            ordinary.content_hash,
            Some(content_sha256(content.as_bytes()))
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn run_index_pages_from_newest_without_truncating_large_unique_history() {
        let (base, ws) = unique_workspace();
        let index_dir = ws.join(".agent-archive/index");
        fs::create_dir_all(&index_dir).expect("mkdir index");
        let content = (0..4_000)
            .map(|index| {
                format!(
                    r#"{{"conversationId":"c-{index}","runId":"r-{index}","padding":"{}"}}"#,
                    "x".repeat(32)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            content.len() > MAX_READ_BYTES,
            "fixture must exceed generic read cap"
        );
        fs::write(index_dir.join("runs.jsonl"), format!("{content}\n")).expect("seed runs index");

        let first = read_workspace_run_index_page_blocking(None, Some(2), root_arg(&ws))
            .expect("first page");
        assert_eq!(first.lines.len(), 2);
        assert_eq!(first.lines[0].line_number, 4_000);
        assert!(first.lines[0].content.contains(r#""runId":"r-3999""#));
        assert!(first.has_more);

        let second =
            read_workspace_run_index_page_blocking(first.cursor.clone(), Some(2), root_arg(&ws))
                .expect("second page");
        assert_eq!(second.lines[0].line_number, 3_998);
        assert!(second.lines[0].content.contains(r#""runId":"r-3997""#));
        assert_eq!(second.snapshot, first.snapshot);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn run_index_cursor_fails_closed_after_append() {
        let (base, ws) = unique_workspace();
        let index_dir = ws.join(".agent-archive/index");
        fs::create_dir_all(&index_dir).expect("mkdir index");
        let index_path = index_dir.join("runs.jsonl");
        fs::write(&index_path, "{\"runId\":\"r1\"}\n{\"runId\":\"r2\"}\n")
            .expect("seed runs index");
        let first = read_workspace_run_index_page_blocking(None, Some(1), root_arg(&ws))
            .expect("first page");
        fs::OpenOptions::new()
            .append(true)
            .open(&index_path)
            .expect("open append")
            .write_all(b"{\"runId\":\"r3\"}\n")
            .expect("append run");

        let error = read_workspace_run_index_page_blocking(first.cursor, Some(1), root_arg(&ws))
            .err()
            .expect("stale cursor must fail");
        assert!(error.contains("changed while paging"), "actual: {error}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn run_index_cursor_fails_closed_after_compaction_replacement() {
        let (base, ws) = unique_workspace();
        let index_dir = ws.join(".agent-archive/index");
        fs::create_dir_all(&index_dir).expect("mkdir index");
        let index_path = index_dir.join("runs.jsonl");
        fs::write(&index_path, "{\"runId\":\"old\"}\n{\"runId\":\"latest\"}\n")
            .expect("seed runs index");
        let first = read_workspace_run_index_page_blocking(None, Some(1), root_arg(&ws))
            .expect("first page");
        let replacement = index_dir.join("runs.jsonl.compact.tmp");
        fs::write(&replacement, "{\"runId\":\"latest\"}\n").expect("write compacted index");
        fs::rename(&replacement, &index_path).expect("replace with compacted index");

        let error = read_workspace_run_index_page_blocking(first.cursor, Some(1), root_arg(&ws))
            .err()
            .expect("cursor from pre-compaction snapshot must fail");
        assert!(error.contains("changed while paging"), "actual: {error}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_files_includes_nested_entry() {
        // list_files 递归列出真实存在的嵌套文件。
        let (base, ws) = unique_workspace();
        fs::create_dir_all(ws.join("src")).expect("mkdir src");
        fs::write(ws.join("src/app.ts"), "export const x = 1;\n").expect("seed nested file");

        let result = list_workspace_files_blocking(
            Some(".".to_string()),
            Some(true),
            None,
            None,
            root_arg(&ws),
        )
        .expect("list should succeed");
        assert!(
            result
                .entries
                .iter()
                .any(|e| e.path == "src/app.ts" && e.entry_type == "file"),
            "应列出 src/app.ts(file)，实际: {:?}",
            result.entries.iter().map(|e| &e.path).collect::<Vec<_>>()
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn search_files_finds_keyword() {
        // search_files 在真实文件里搜到关键字，返回相对路径 + 行号 + 命中行。
        let (base, ws) = unique_workspace();
        fs::create_dir_all(ws.join("src")).expect("mkdir src");
        fs::write(
            ws.join("src/app.ts"),
            "line one\nfind NEEDLE_TOKEN here\nline three\n",
        )
        .expect("seed file");

        let result = search_workspace_files_blocking(
            "NEEDLE_TOKEN".to_string(),
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("search should succeed");
        assert_eq!(result.matches.len(), 1, "应命中 1 处");
        let m = &result.matches[0];
        assert_eq!(m.path, "src/app.ts");
        assert_eq!(m.line_number, 2, "命中在第 2 行");
        assert!(m.line.contains("NEEDLE_TOKEN"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn read_rejects_parent_escape() {
        // 真实越界：在 workspace 外(base)放 secret.txt，用 ../secret.txt 读 → 被 confine 拒。
        let (base, ws) = unique_workspace();
        fs::write(base.join("secret.txt"), "top secret").expect("seed outside file");

        // ReadWorkspaceFileResult 无 Debug，避免 expect_err，直接 match 取 Err。
        let err =
            match read_workspace_file_blocking("../secret.txt".to_string(), None, root_arg(&ws)) {
                Err(err) => err,
                Ok(_) => panic!("workspace 外文件必须被拒"),
            };
        assert!(
            err.contains("escapes workspace root") || err.contains("not accessible"),
            "应因越界被拒，实际: {err}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn read_rejects_absolute_outside_path() {
        // workspace 外的绝对路径 → canonicalize 后 starts_with(root) 失败被拒。
        let (base, ws) = unique_workspace();
        let outside = base.join("secret.txt");
        fs::write(&outside, "top secret").expect("seed outside file");

        let err = match read_workspace_file_blocking(
            outside.to_string_lossy().into_owned(),
            None,
            root_arg(&ws),
        ) {
            Err(err) => err,
            Ok(_) => panic!("workspace 外绝对路径必须被拒"),
        };
        assert!(
            err.contains("escapes workspace root"),
            "应因越界被拒，实际: {err}"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_read_allows_parent_and_absolute_outside_paths() {
        let (base, ws) = unique_workspace();
        let outside = base.join("secret.txt");
        fs::write(&outside, "auto readable").expect("seed outside file");
        let outside = fs::canonicalize(&outside).expect("canonicalize outside");
        let expected_path = display_path(&outside);

        let via_parent = read_workspace_file_blocking_with_access(
            "../secret.txt".to_string(),
            None,
            root_arg(&ws),
            true,
        )
        .expect("Auto should allow parent path");
        assert_eq!(via_parent.content, "auto readable");
        assert_eq!(via_parent.path, expected_path);

        let via_absolute = read_workspace_file_blocking_with_access(
            outside.to_string_lossy().into_owned(),
            None,
            root_arg(&ws),
            true,
        )
        .expect("Auto should allow absolute outside path");
        assert_eq!(via_absolute.content, "auto readable");
        assert_eq!(via_absolute.path, expected_path);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_list_and_search_allow_external_directory() {
        let (base, ws) = unique_workspace();
        let outside_dir = base.join("outside");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        let outside_file = outside_dir.join("notes.txt");
        fs::write(&outside_file, "line one\nAUTO_OUTSIDE_NEEDLE\n").expect("seed outside file");
        let outside_dir = fs::canonicalize(&outside_dir).expect("canonicalize outside dir");
        let outside_file = fs::canonicalize(&outside_file).expect("canonicalize outside file");
        let expected_path = display_path(&outside_file);

        let listed = list_workspace_files_blocking_with_access(
            Some(outside_dir.to_string_lossy().into_owned()),
            Some(false),
            None,
            None,
            root_arg(&ws),
            true,
        )
        .expect("Auto should list outside dir");
        assert!(
            listed
                .entries
                .iter()
                .any(|entry| entry.path == expected_path && entry.entry_type == "file"),
            "external list should return absolute path"
        );

        let searched = search_workspace_files_blocking_with_access(
            "AUTO_OUTSIDE_NEEDLE".to_string(),
            Some("../outside".to_string()),
            None,
            None,
            root_arg(&ws),
            true,
        )
        .expect("Auto should search outside dir");
        assert_eq!(searched.matches.len(), 1);
        assert_eq!(searched.matches[0].path, expected_path);
        assert_eq!(searched.matches[0].line_number, 2);

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn auto_read_follows_symlink_to_external_file_while_confirm_rejects_it() {
        use std::os::unix::fs::symlink;

        let (base, ws) = unique_workspace();
        let outside = base.join("secret.txt");
        fs::write(&outside, "linked outside").expect("seed outside file");
        symlink(&outside, ws.join("linked-secret.txt")).expect("create symlink");

        let strict_error = match read_workspace_file_blocking(
            "linked-secret.txt".to_string(),
            None,
            root_arg(&ws),
        ) {
            Err(err) => err,
            Ok(_) => panic!("Confirm must reject a symlink escaping workspace"),
        };
        assert!(strict_error.contains("escapes workspace root"));

        let result = read_workspace_file_blocking_with_access(
            "linked-secret.txt".to_string(),
            None,
            root_arg(&ws),
            true,
        )
        .expect("Auto should follow external symlink");
        assert_eq!(result.content, "linked outside");
        assert_eq!(
            result.path,
            display_path(&fs::canonicalize(&outside).expect("canonicalize outside"))
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_workspace_root_rejects_filesystem_root() {
        // resolve_workspace_root(Some("/")) → 拒（文件系统根，否则整块磁盘都成 workspace，confine 形同虚设）。
        let err = resolve_workspace_root(Some("/")).expect_err("文件系统根必须被拒");
        assert!(
            err.contains("filesystem root"),
            "应因文件系统根被拒，实际: {err}"
        );
    }
}
