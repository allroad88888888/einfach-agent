//! list_files 的目录条目列举与递归收集。

use super::limits::{normalize_positive, DEFAULT_LIST_MAX_ENTRIES, MAX_LIST_ENTRIES};
use super::paths::{display_path, optional_path_or_default, relative_path, resolve_workspace_path};
use super::types::{ListWorkspaceFilesResult, WorkspaceFileEntry};
use super::walk::{is_hidden, sorted_read_dir};
use crate::workspace_common::resolve_workspace_root;
use std::{fs, path::Path};

#[cfg(test)]
pub(super) fn list_workspace_files_blocking(
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

pub(super) fn list_workspace_files_blocking_with_access(
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

#[cfg(test)]
#[path = "workspace_read_list_tests.rs"]
mod tests;
