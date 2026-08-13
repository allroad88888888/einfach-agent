//! 补丁落盘原语：读旧文本、原子写、执行位与删除。

use super::limits::MAX_FILE_BYTES;
use super::path::ensure_parent_inside_root;
use crate::workspace_common::atomic_write;
use std::{fs, path::Path};

pub(super) fn read_optional_text_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(path)
        .map_err(|err| format!("failed to read metadata for `{}`: {err}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("`{}` is not a regular file", path.display()));
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(format!("file exceeds {} byte limit", MAX_FILE_BYTES));
    }

    let bytes =
        fs::read(path).map_err(|err| format!("failed to read `{}`: {err}", path.display()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} byte limit", MAX_FILE_BYTES));
    }
    if bytes.contains(&0) {
        return Err("binary files are not supported".to_string());
    }

    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "binary files are not supported".to_string())
}

pub(super) fn write_text_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_inside_root(root, path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create parent directory `{}`: {err}",
                parent.display()
            )
        })?;
        let canonical_parent = fs::canonicalize(parent).map_err(|err| {
            format!(
                "failed to resolve parent directory `{}`: {err}",
                parent.display()
            )
        })?;
        if !canonical_parent.starts_with(root) {
            return Err("parent directory is outside the workspace root".to_string());
        }
    }
    // 与 write_file 走同一个崩溃安全实现：commit 中途失败/断电不能留下截断文件，
    // 否则 rollback 面对的已经是一个坏文件了。
    atomic_write(path, content.as_bytes())
        .map_err(|err| format!("failed to write `{}`: {err}", path.display()))
}

/// Mirror write_file's executable handling so the same request means the same thing
/// in both tools.
#[cfg(unix)]
pub(super) fn apply_executable_bit(path: &Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to inspect file mode: {err}"))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    let updated = if executable {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode & !0o111
    };
    if updated == mode {
        return Ok(());
    }
    permissions.set_mode(updated);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("failed to update file mode: {err}"))
}

#[cfg(not(unix))]
pub(super) fn apply_executable_bit(_path: &Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

pub(super) fn delete_file_if_present(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|err| format!("failed to delete `{}`: {err}", path.display()))
}
