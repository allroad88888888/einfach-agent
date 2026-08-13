//! 日志记录的相对路径与文件快照在 workspace 内的受限还原。

use super::types::FileSnapshot;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(super) fn write_snapshot(
    root: &Path,
    path: &Path,
    snapshot: &FileSnapshot,
) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err("recorded path escaped workspace root".to_string());
    }
    match &snapshot.content {
        Some(content) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("failed to create `{}`: {err}", parent.display()))?;
                let canonical_parent = fs::canonicalize(parent)
                    .map_err(|err| format!("failed to resolve `{}`: {err}", parent.display()))?;
                if !canonical_parent.starts_with(root) {
                    return Err("recorded path escaped workspace root".to_string());
                }
            }
            fs::write(path, content)
                .map_err(|err| format!("failed to restore `{}`: {err}", path.display()))
        }
        None => {
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|err| format!("failed to remove `{}`: {err}", path.display()))?;
            }
            Ok(())
        }
    }
}

pub(super) fn read_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    if !path.exists() {
        return Ok(FileSnapshot::from_content(None));
    }
    let bytes =
        fs::read(path).map_err(|err| format!("failed to read `{}`: {err}", path.display()))?;
    if bytes.contains(&0) {
        return Err(format!(
            "binary file is not reversible: `{}`",
            path.display()
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("non-UTF-8 file is not reversible: `{}`", path.display()))?;
    Ok(FileSnapshot::from_content(Some(content)))
}

pub(super) fn resolve_recorded_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let raw = Path::new(relative);
    if raw.is_absolute()
        || raw.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("invalid path in workspace change journal".to_string());
    }
    let path = root.join(raw);
    if path.exists() {
        let canonical = fs::canonicalize(&path)
            .map_err(|err| format!("failed to resolve `{}`: {err}", path.display()))?;
        if !canonical.starts_with(root) {
            return Err("recorded path escaped workspace root".to_string());
        }
        Ok(canonical)
    } else {
        let mut ancestor = path.parent();
        while let Some(candidate) = ancestor {
            if candidate.exists() {
                let canonical = fs::canonicalize(candidate)
                    .map_err(|err| format!("failed to resolve `{}`: {err}", candidate.display()))?;
                if !canonical.starts_with(root) {
                    return Err("recorded path escaped workspace root".to_string());
                }
                break;
            }
            ancestor = candidate.parent();
        }
        Ok(path)
    }
}
