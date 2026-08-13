//! search_files 的关键字扫描：遍历预算、glob 过滤与命中行收集。

use super::content::{cap_chars, decode_utf8, reject_binary_bytes};
use super::limits::{
    normalize_positive, DEFAULT_SEARCH_MAX_MATCHES, MAX_SEARCH_FILE_BYTES, MAX_SEARCH_LINE_CHARS,
    MAX_SEARCH_MATCHES, MAX_SEARCH_SCANNED_ENTRIES,
};
use super::paths::{display_path, optional_path_or_default, relative_path, resolve_workspace_path};
use super::types::{SearchWorkspaceFilesResult, WorkspaceSearchMatch};
use super::walk::{is_excluded_dir, is_hidden, sorted_read_dir};
use crate::workspace_common::resolve_workspace_root;
use std::{fs, fs::File, io::Read, path::Path};

#[cfg(test)]
pub(super) fn search_workspace_files_blocking(
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

pub(super) fn search_workspace_files_blocking_with_access(
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

#[cfg(test)]
#[path = "workspace_read_search_tests.rs"]
mod tests;
