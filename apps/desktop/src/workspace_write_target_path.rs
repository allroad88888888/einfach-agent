//! 写入目标路径在 workspace root 下的解析、限域与对外展示形式。

use std::{
    fs,
    path::{Component, Path, PathBuf, MAIN_SEPARATOR},
};

pub(super) fn resolve_workspace_path(
    workspace_root: &Path,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path cannot contain NUL bytes".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    let joined = if input_path.is_absolute() {
        input_path
    } else {
        workspace_root.join(input_path)
    };
    let normalized = normalize_path(&joined)?;
    if !is_within_workspace(workspace_root, &normalized) {
        return Err("path must stay within the workspace root".to_string());
    }

    resolve_existing_ancestor(workspace_root, &normalized)
}

fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("path must not contain `..` components".to_string());
            }
            Component::Normal(part) => normalized.push(part),
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

fn resolve_existing_ancestor(workspace_root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.exists() {
        let canonical = fs::canonicalize(target).map_err(|err| {
            format!(
                "failed to resolve target path `{}`: {err}",
                target.to_string_lossy()
            )
        })?;
        if !is_within_workspace(workspace_root, &canonical) {
            return Err("path must stay within the workspace root".to_string());
        }
        return Ok(canonical);
    }

    let mut missing = Vec::new();
    let mut cursor = target;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            return Err(format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            ));
        };
        missing.push(name.to_owned());
        cursor = cursor.parent().ok_or_else(|| {
            format!(
                "no existing ancestor found for `{}`",
                target.to_string_lossy()
            )
        })?;
    }

    let mut resolved = fs::canonicalize(cursor).map_err(|err| {
        format!(
            "failed to resolve ancestor `{}`: {err}",
            cursor.to_string_lossy()
        )
    })?;
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }

    for part in missing.iter().rev() {
        resolved.push(part);
    }
    if !is_within_workspace(workspace_root, &resolved) {
        return Err("path must stay within the workspace root".to_string());
    }
    Ok(resolved)
}

fn is_within_workspace(workspace_root: &Path, target: &Path) -> bool {
    target == workspace_root || target.starts_with(workspace_root)
}

// P2：把绝对路径转成相对 workspace root 的斜杠路径（与 workspace_read 同语义）——
// 结果 path 对外一律 workspace 相对，不泄漏本机绝对路径。root 外的意外路径回退为原样。
pub(super) fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    path_to_slash_string(relative)
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
    use crate::workspace_write::pipeline::write_workspace_file_blocking;
    use crate::workspace_write::test_support::{root_arg, unique_workspace};
    use std::fs;

    #[test]
    fn rejects_parent_escape() {
        // ../ 越界写：结构化失败(ok=false，error 含 ..)，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "../evil.txt".to_string(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "../ 越界写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(err.contains(".."), "应因 .. 被拒，实际: {err}");
        assert!(!base.join("evil.txt").exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_absolute_outside_path() {
        // workspace 外绝对路径写：ok=false，磁盘上不留文件。
        let (base, ws) = unique_workspace();
        let outside = base.join("evil.txt");
        let result = write_workspace_file_blocking(
            outside.to_string_lossy().into_owned(),
            "nope".to_string(),
            Some("create".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("worker 层不应报错");
        assert!(!result.ok, "workspace 外绝对路径写必须失败");
        let err = result.error.unwrap_or_default();
        assert!(
            err.contains("within the workspace root"),
            "应因越界被拒，实际: {err}"
        );
        assert!(!outside.exists(), "越界文件不应被创建");

        let _ = fs::remove_dir_all(&base);
    }
}
