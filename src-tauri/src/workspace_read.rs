use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use std::{
    fs,
    fs::File,
    io::Read,
    path::{Path, PathBuf, MAIN_SEPARATOR},
};

const DEFAULT_READ_MAX_BYTES: usize = 20_000;
const MAX_READ_BYTES: usize = 200_000;
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
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_blocking(path, max_bytes, workspace_root)
    })
    .await
    .map_err(|err| format!("read_workspace_file worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_workspace_files(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
) -> Result<ListWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_files_blocking(path, recursive, max_entries, include_hidden, workspace_root)
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
) -> Result<SearchWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_files_blocking(query, path, glob, max_matches, workspace_root)
    })
    .await
    .map_err(|err| format!("search_workspace_files worker failed: {err}"))?
}

fn read_workspace_file_blocking(
    path: String,
    max_bytes: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceFileResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let requested = path.trim();
    if requested.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }

    let file_path = resolve_workspace_path(&root, requested)?;
    let metadata = fs::metadata(&file_path).map_err(|err| {
        format!(
            "file `{}` is not accessible: {err}",
            display_path(&file_path)
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("path `{}` is not a file", display_path(&file_path)));
    }

    let max_bytes = normalize_positive(max_bytes, DEFAULT_READ_MAX_BYTES, MAX_READ_BYTES);
    let mut file = File::open(&file_path)
        .map_err(|err| format!("failed to open `{}`: {err}", display_path(&file_path)))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("failed to read `{}`: {err}", display_path(&file_path)))?;

    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }
    reject_binary_bytes(&bytes, &file_path)?;
    let content = decode_utf8(&bytes, truncated, &file_path)?;
    let bytes = content.as_bytes().len();

    Ok(ReadWorkspaceFileResult {
        path: relative_path(&root, &file_path),
        content,
        truncated,
        bytes,
    })
}

fn list_workspace_files_blocking(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
) -> Result<ListWorkspaceFilesResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let requested = optional_path_or_default(path.as_deref(), ".");
    let dir = resolve_workspace_path(&root, requested)?;
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
        &mut entries,
        &mut truncated,
    )?;

    Ok(ListWorkspaceFilesResult { entries, truncated })
}

fn search_workspace_files_blocking(
    query: String,
    path: Option<String>,
    glob: Option<String>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
) -> Result<SearchWorkspaceFilesResult, String> {
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query (non-empty string) is required".to_string());
    }

    let requested = optional_path_or_default(path.as_deref(), ".");
    let target = resolve_workspace_path(&root, requested)?;
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

fn resolve_workspace_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested_path = PathBuf::from(requested);
    let joined = if requested_path.is_absolute() {
        requested_path
    } else {
        root.join(requested_path)
    };
    // P1 confine：绝对路径也一样先 canonicalize（解析符号链接/`..`），再校验 starts_with(root)——
    // 绝对路径不能绕过限制。配合 resolve_workspace_root 拒 `/`，cwd 不可控也不会失守。
    let resolved = fs::canonicalize(&joined).map_err(|err| {
        format!(
            "path `{}` is not accessible in workspace `{}`: {err}",
            requested,
            display_path(root)
        )
    })?;

    if !resolved.starts_with(root) {
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
        if !resolved.starts_with(root) {
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
        if !resolved.starts_with(root) {
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
                root, &path, query, glob, max_matches, scanned, matches, truncated,
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
