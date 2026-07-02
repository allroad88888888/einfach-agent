use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, MAIN_SEPARATOR, Path, PathBuf},
};

const DEFAULT_MAX_BYTES: usize = 200 * 1024;
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
pub struct WorkspaceWriteResult {
    ok: bool,
    path: String,
    bytes_written: usize,
    created: bool,
    overwritten: bool,
    appended: bool,
    error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteMode {
    Create,
    Overwrite,
    Append,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn write_workspace_file(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    workspace_root: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_workspace_file_blocking(
            path,
            content,
            mode,
            expected_old_content,
            create_dirs,
            max_bytes,
            workspace_root,
        )
    })
    .await
    .map_err(|err| format!("workspace write worker failed: {err}"))?
}

fn write_workspace_file_blocking(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    workspace_root_arg: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    let mode = match parse_mode(mode.as_deref()) {
        Ok(mode) => mode,
        Err(err) => return Ok(error_result(&path, err)),
    };
    if content.contains('\0') {
        return Ok(error_result(&path, "binary content is not supported"));
    }

    let max_bytes = normalize_max_bytes(max_bytes);
    let bytes = content.as_bytes().len();
    if bytes > max_bytes {
        return Ok(error_result(
            &path,
            format!("content is too large: {bytes} bytes exceeds limit {max_bytes}"),
        ));
    }

    let workspace_root = match resolve_workspace_root(workspace_root_arg.as_deref()) {
        Ok(root) => root,
        Err(err) => return Ok(error_result(&path, err)),
    };
    let target_path = match resolve_workspace_path(&workspace_root, &path) {
        Ok(path) => path,
        Err(err) => return Ok(error_result(&path, err)),
    };
    // P2：返回相对 workspace root 的路径（与 read/list/patch 一致），不把 /Users/.../repo 这类
    // 绝对路径泄漏给 model 与聊天记录。
    let display_path = relative_path(&workspace_root, &target_path);

    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            if create_dirs.unwrap_or(false) {
                if let Err(err) = fs::create_dir_all(parent) {
                    return Ok(error_result(
                        &display_path,
                        format!("failed to create parent directories: {err}"),
                    ));
                }
            } else {
                return Ok(error_result(
                    &display_path,
                    "parent directory does not exist; set createDirs=true to create it",
                ));
            }
        }
    }

    let existed = target_path.exists();
    let write_result = match mode {
        WriteMode::Create => write_create(&target_path, content.as_bytes()),
        WriteMode::Overwrite => {
            if !existed {
                Err("cannot overwrite a file that does not exist".to_string())
            } else {
                verify_expected_content(&target_path, expected_old_content.as_deref())
                    .and_then(|_| fs::write(&target_path, content.as_bytes()).map_err(to_io_error))
            }
        }
        WriteMode::Append => write_append(&target_path, content.as_bytes()),
    };

    match write_result {
        Ok(()) => Ok(WorkspaceWriteResult {
            ok: true,
            path: display_path,
            bytes_written: bytes,
            created: !existed,
            overwritten: mode == WriteMode::Overwrite,
            appended: mode == WriteMode::Append,
            error: None,
        }),
        Err(err) => Ok(error_result(&display_path, err)),
    }
}

// P2：把绝对路径转成相对 workspace root 的斜杠路径（与 workspace_read 同语义）——
// 结果 path 对外一律 workspace 相对，不泄漏本机绝对路径。root 外的意外路径回退为原样。
fn relative_path(root: &Path, path: &Path) -> String {
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

fn write_create(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

fn write_append(path: &Path, content: &[u8]) -> Result<(), String> {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(content))
        .map_err(to_io_error)
}

fn verify_expected_content(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };

    let current = fs::read_to_string(path)
        .map_err(|err| format!("failed to read existing file for expectedOldContent: {err}"))?;
    if current != expected {
        return Err("expectedOldContent does not match current file content".to_string());
    }
    Ok(())
}

fn parse_mode(mode: Option<&str>) -> Result<WriteMode, String> {
    match mode.unwrap_or("create") {
        "create" => Ok(WriteMode::Create),
        "overwrite" => Ok(WriteMode::Overwrite),
        "append" => Ok(WriteMode::Append),
        other => Err(format!(
            "invalid mode `{other}`; expected `create`, `overwrite`, or `append`"
        )),
    }
}

fn normalize_max_bytes(max_bytes: Option<usize>) -> usize {
    match max_bytes {
        Some(value) if value > 0 => value.min(MAX_BYTES),
        _ => DEFAULT_MAX_BYTES,
    }
}

fn resolve_workspace_path(workspace_root: &Path, raw_path: &str) -> Result<PathBuf, String> {
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

fn error_result(path: &str, error: impl Into<String>) -> WorkspaceWriteResult {
    WorkspaceWriteResult {
        ok: false,
        path: path.to_string(),
        bytes_written: 0,
        created: false,
        overwritten: false,
        appended: false,
        error: Some(error.into()),
    }
}

fn to_io_error(err: std::io::Error) -> String {
    err.to_string()
}
