//! 补丁目标路径的规范化与 workspace 边界约束。

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(super) fn resolve_workspace_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = raw_path.trim();
    if path.is_empty() {
        return Err("path must be a non-empty string".to_string());
    }

    let raw = Path::new(path);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };
    let normalized = normalize_no_parent(&joined)?;
    if !normalized.starts_with(root) {
        return Err("path is outside the workspace root".to_string());
    }

    if let Ok(metadata) = fs::symlink_metadata(&normalized) {
        if metadata.file_type().is_symlink() {
            return Err("symlink paths are not supported".to_string());
        }
        let canonical = fs::canonicalize(&normalized).map_err(|err| {
            format!(
                "failed to resolve path `{}`: {err}",
                normalized.to_string_lossy()
            )
        })?;
        if !canonical.starts_with(root) {
            return Err("path is outside the workspace root".to_string());
        }
        return Ok(canonical);
    }

    ensure_parent_inside_root(root, &normalized)?;
    Ok(normalized)
}

fn normalize_no_parent(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path must not contain `..` components".to_string());
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

pub(super) fn ensure_parent_inside_root(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "path must have a parent directory".to_string())?;
    if !parent.starts_with(root) {
        return Err("parent directory is outside the workspace root".to_string());
    }

    let existing = nearest_existing_ancestor(parent)?;
    let canonical = fs::canonicalize(&existing).map_err(|err| {
        format!(
            "failed to resolve parent directory `{}`: {err}",
            existing.display()
        )
    })?;
    if !canonical.starts_with(root) {
        return Err("parent directory is outside the workspace root".to_string());
    }
    Ok(())
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return Ok(current);
        }
        if !current.pop() {
            return Err(format!(
                "no existing ancestor found for `{}`",
                path.display()
            ));
        }
    }
}

pub(super) fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
