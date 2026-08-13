//! git diff pathspec 的 workspace 内 confine 校验与路径归一化。

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(super) fn normalize_paths(paths: Option<Vec<String>>, root: &Path) -> Result<Vec<String>, String> {
    let Some(paths) = paths else {
        return Ok(Vec::new());
    };

    let mut normalized = Vec::new();
    for path in paths {
        normalized.push(normalize_path(&path, root)?);
    }
    Ok(normalized)
}

fn normalize_path(path: &str, root: &Path) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("git diff path cannot be empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err(format!("git diff path `{trimmed}` contains a NUL byte"));
    }

    let input = PathBuf::from(trimmed);
    let relative = if input.is_absolute() {
        relative_from_absolute(&input, root)?
    } else {
        relative_from_relative(&input, root)?
    };

    if relative.as_os_str().is_empty() {
        return Err(
            "git diff path cannot resolve to the workspace root; omit paths instead".to_string(),
        );
    }

    Ok(pathbuf_to_git_path(&relative))
}

fn relative_from_absolute(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let candidate = lexical_normalize_absolute(path)?;

    if !candidate.starts_with(root) {
        return Err(format!(
            "git diff path `{}` escapes workspace root `{}`",
            path.to_string_lossy(),
            root.to_string_lossy()
        ));
    }
    ensure_existing_ancestor_in_root(&candidate, root, path)?;

    candidate
        .strip_prefix(root)
        .map(PathBuf::from)
        .map_err(|err| format!("failed to make path relative to workspace root: {err}"))
}

fn relative_from_relative(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "git diff path `{}` must stay inside workspace root",
                    path.to_string_lossy()
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "git diff path `{}` must be relative to workspace root",
                    path.to_string_lossy()
                ));
            }
        }
    }

    let candidate = root.join(&relative);
    ensure_existing_ancestor_in_root(&candidate, root, path)?;

    Ok(relative)
}

fn ensure_existing_ancestor_in_root(
    candidate: &Path,
    root: &Path,
    original: &Path,
) -> Result<(), String> {
    let mut existing = candidate.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return Err(format!(
                "git diff path `{}` has no accessible parent",
                original.to_string_lossy()
            ));
        }
    }

    let canonical = fs::canonicalize(&existing).map_err(|err| {
        format!(
            "failed to resolve path `{}`: {err}",
            existing.to_string_lossy()
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "git diff path `{}` escapes workspace root `{}`",
            original.to_string_lossy(),
            root.to_string_lossy()
        ));
    }

    Ok(())
}

fn lexical_normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "absolute git diff path `{}` cannot be normalized",
                        path.to_string_lossy()
                    ));
                }
            }
        }
    }
    Ok(normalized)
}

fn pathbuf_to_git_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
