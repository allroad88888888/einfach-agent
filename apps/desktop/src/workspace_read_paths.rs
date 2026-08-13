//! workspace 路径的解析、越界校验与对外展示形式。

use std::{
    fs,
    path::{Path, PathBuf, MAIN_SEPARATOR},
};

pub(super) fn optional_path_or_default<'a>(
    path: Option<&'a str>,
    default_path: &'a str,
) -> &'a str {
    match path {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => default_path,
    }
}

pub(super) fn resolve_workspace_path(
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

pub(super) fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    path_to_slash_string(relative)
}

pub(super) fn display_path(path: &Path) -> String {
    path_to_slash_string(path)
}

pub(super) fn path_to_slash_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    if MAIN_SEPARATOR == '/' {
        text.into_owned()
    } else {
        text.replace(MAIN_SEPARATOR, "/")
    }
}

#[cfg(test)]
#[path = "workspace_read_confinement_tests.rs"]
mod tests;
