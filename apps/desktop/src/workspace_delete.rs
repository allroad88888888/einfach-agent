use crate::workspace_change_journal::{
    change_payload_path, copy_path, discard_prepared_change, journal_dir, mark_change_applied,
    prepare_deleted_path_change, WorkspaceChangeContext, WorkspaceChangeSummary,
};
use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf, MAIN_SEPARATOR},
};

const MAX_ENTRIES: u64 = 20_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Serialize)]
pub struct WorkspaceDeleteResult {
    ok: bool,
    path: String,
    deleted: bool,
    kind: Option<String>,
    reversible: bool,
    error: Option<String>,
    change_set: Option<WorkspaceChangeSummary>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_workspace_path(
    app: tauri::AppHandle,
    path: String,
    recursive: Option<bool>,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspaceDeleteResult, String> {
    let journal = journal_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_workspace_path_blocking(
            path,
            recursive.unwrap_or(false),
            workspace_root,
            journal,
            change_context,
        )
    })
    .await
    .map_err(|err| format!("workspace delete worker failed: {err}"))?
}

fn delete_workspace_path_blocking(
    path: String,
    recursive: bool,
    workspace_root_arg: Option<String>,
    journal: PathBuf,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspaceDeleteResult, String> {
    let root = match resolve_workspace_root(workspace_root_arg.as_deref()) {
        Ok(root) => root,
        Err(error) => return Ok(error_result(&path, error)),
    };
    let target = match resolve_delete_path(&root, &path) {
        Ok(target) => target,
        Err(error) => return Ok(error_result(&path, error)),
    };
    let display_path = relative_path(&root, &target);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(error_result(&display_path, "path does not exist"))
        }
        Err(error) => {
            return Ok(error_result(
                &display_path,
                format!("failed to inspect path: {error}"),
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        return Ok(error_result(
            &display_path,
            "symbolic links are not supported by recoverable delete",
        ));
    }
    if metadata.is_dir() && !recursive {
        return Ok(error_result(
            &display_path,
            "directory deletion requires recursive=true",
        ));
    }
    if display_path == ".git" || display_path.starts_with(".git/") {
        return Ok(error_result(
            &display_path,
            "recoverable delete refuses Git metadata",
        ));
    }
    if let Err(error) = inspect_tree(&target) {
        return Ok(error_result(&display_path, error));
    }

    let Some(context) = change_context else {
        return Ok(error_result(
            &display_path,
            "recoverable delete requires runtime change context",
        ));
    };
    let change_id = context.change_id.clone();
    let change_set =
        match prepare_deleted_path_change(&journal, context, &root, display_path.clone()) {
            Ok(summary) => summary,
            Err(error) => return Ok(error_result(&display_path, error)),
        };
    let payload = match change_payload_path(&journal, &change_id) {
        Ok(payload) => payload,
        Err(error) => {
            discard_prepared_change(&journal, &change_id);
            return Ok(error_result(&display_path, error));
        }
    };
    if let Err(error) = copy_path(&target, &payload) {
        discard_prepared_change(&journal, &change_id);
        return Ok(error_result(&display_path, error));
    }

    let remove_result = if metadata.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    if let Err(error) = remove_result {
        let restoration = restore_after_failure(&payload, &target);
        if restoration.is_ok() {
            discard_prepared_change(&journal, &change_id);
        }
        return Ok(error_result(
            &display_path,
            match restoration {
                Ok(()) => format!("failed to delete path: {error}"),
                Err(restore_error) => format!(
                    "failed to delete path: {error}; automatic restoration also failed: {restore_error}"
                ),
            },
        ));
    }

    if let Err(error) = mark_change_applied(&journal, &change_id) {
        let restoration = copy_path(&payload, &target);
        if restoration.is_ok() {
            discard_prepared_change(&journal, &change_id);
        }
        return Ok(error_result(
            &display_path,
            match restoration {
                Ok(()) => error,
                Err(restore_error) => {
                    format!("{error}; automatic restoration also failed: {restore_error}")
                }
            },
        ));
    }

    Ok(WorkspaceDeleteResult {
        ok: true,
        path: display_path,
        deleted: true,
        kind: Some(if metadata.is_dir() {
            "directory".to_string()
        } else {
            "file".to_string()
        }),
        reversible: true,
        error: None,
        change_set: Some(change_set),
    })
}

fn restore_after_failure(payload: &Path, target: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if metadata.is_dir() {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        }
        .map_err(|error| format!("failed to remove partial target: {error}"))?;
    }
    copy_path(payload, target)
}

fn inspect_tree(path: &Path) -> Result<(), String> {
    fn walk(path: &Path, entries: &mut u64, bytes: &mut u64) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("failed to inspect `{}`: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "symbolic links are not supported by recoverable delete: `{}`",
                path.display()
            ));
        }
        *entries += 1;
        if metadata.is_file() {
            *bytes = bytes.saturating_add(metadata.len());
        }
        if *entries > MAX_ENTRIES || *bytes > MAX_BYTES {
            return Err(format!(
                "path is too large for recoverable delete (limit: {MAX_ENTRIES} entries or {MAX_BYTES} bytes)"
            ));
        }
        if metadata.is_dir() {
            for child in fs::read_dir(path)
                .map_err(|error| format!("failed to read `{}`: {error}", path.display()))?
            {
                walk(
                    &child
                        .map_err(|error| format!("failed to read directory entry: {error}"))?
                        .path(),
                    entries,
                    bytes,
                )?;
            }
        }
        Ok(())
    }
    walk(path, &mut 0, &mut 0)
}

fn resolve_delete_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path (non-empty string) is required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("path cannot contain NUL bytes".to_string());
    }
    let input = PathBuf::from(trimmed);
    let joined = if input.is_absolute() {
        input
    } else {
        root.join(input)
    };
    if joined
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path must not contain `..` components".to_string());
    }
    if !joined.starts_with(root) {
        return Err("path must stay within the workspace root".to_string());
    }

    let relative = joined
        .strip_prefix(root)
        .map_err(|_| "path must stay within the workspace root".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(segment) => current.push(segment),
            _ => return Err("path must stay within the workspace root".to_string()),
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("failed to resolve target path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "symbolic links are not supported by recoverable delete: `{}`",
                current.display()
            ));
        }
    }

    let canonical = fs::canonicalize(&current)
        .map_err(|error| format!("failed to resolve target path: {error}"))?;
    if canonical == root {
        return Err("refusing to delete the workspace root".to_string());
    }
    if !canonical.starts_with(root) {
        return Err("path must stay within the workspace root".to_string());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> String {
    let text = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
    if MAIN_SEPARATOR == '/' {
        text.into_owned()
    } else {
        text.replace(MAIN_SEPARATOR, "/")
    }
}

fn error_result(path: &str, error: impl Into<String>) -> WorkspaceDeleteResult {
    WorkspaceDeleteResult {
        ok: false,
        path: path.to_string(),
        deleted: false,
        kind: None,
        reversible: false,
        error: Some(error.into()),
        change_set: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_change_journal::revert_change_set_blocking;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn roots() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "workspace_delete_test_{}_{}",
            std::process::id(),
            seq
        ));
        let workspace = base.join("workspace");
        let journal = base.join("journal");
        fs::create_dir_all(&workspace).expect("create workspace");
        (
            fs::canonicalize(workspace).expect("canonical workspace"),
            journal,
        )
    }

    fn context(id: &str) -> WorkspaceChangeContext {
        WorkspaceChangeContext {
            change_id: id.to_string(),
            session_id: "session".to_string(),
            run_id: "run".to_string(),
            tool_call_id: "call".to_string(),
        }
    }

    #[test]
    fn deletes_and_restores_binary_file() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("image.bin"), [0, 1, 2, 255]).expect("seed");
        let result = delete_workspace_path_blocking(
            "image.bin".to_string(),
            false,
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("delete-file")),
        )
        .expect("delete");
        assert!(result.ok);
        assert!(!workspace.join("image.bin").exists());

        let reverted =
            revert_change_set_blocking(&journal, "delete-file", false, &workspace).expect("revert");
        assert!(reverted.ok);
        assert_eq!(
            fs::read(workspace.join("image.bin")).unwrap(),
            [0, 1, 2, 255]
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn deletes_and_restores_directory_tree() {
        let (workspace, journal) = roots();
        fs::create_dir_all(workspace.join("build/nested")).expect("mkdir");
        fs::write(workspace.join("build/a.txt"), "a").expect("seed a");
        fs::write(workspace.join("build/nested/b.txt"), "b").expect("seed b");
        let result = delete_workspace_path_blocking(
            "build".to_string(),
            true,
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("delete-dir")),
        )
        .expect("delete");
        assert!(result.ok);
        assert!(!workspace.join("build").exists());

        let reverted =
            revert_change_set_blocking(&journal, "delete-dir", false, &workspace).expect("revert");
        assert!(reverted.ok);
        assert_eq!(
            fs::read_to_string(workspace.join("build/nested/b.txt")).unwrap(),
            "b"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn refuses_directory_without_recursive_and_workspace_root() {
        let (workspace, journal) = roots();
        fs::create_dir(workspace.join("build")).expect("mkdir");
        let result = delete_workspace_path_blocking(
            "build".to_string(),
            false,
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("no-recursive")),
        )
        .expect("delete");
        assert!(!result.ok);
        assert!(workspace.join("build").exists());

        let root_result = delete_workspace_path_blocking(
            ".".to_string(),
            true,
            Some(workspace.to_string_lossy().into_owned()),
            journal,
            Some(context("root")),
        )
        .expect("delete root");
        assert!(!root_result.ok);
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn revert_refuses_recreated_path_without_overwrite() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("note.txt"), "original").expect("seed");
        delete_workspace_path_blocking(
            "note.txt".to_string(),
            false,
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("conflict-delete")),
        )
        .expect("delete");
        fs::write(workspace.join("note.txt"), "new user file").expect("recreate");

        let reverted = revert_change_set_blocking(&journal, "conflict-delete", false, &workspace)
            .expect("revert");
        assert!(!reverted.ok);
        assert_eq!(reverted.status, "conflict");
        assert_eq!(
            fs::read_to_string(workspace.join("note.txt")).unwrap(),
            "new user file"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_link_in_path() {
        use std::os::unix::fs::symlink;

        let (workspace, journal) = roots();
        fs::create_dir(workspace.join("real")).expect("mkdir");
        fs::write(workspace.join("real/note.txt"), "keep").expect("seed");
        symlink(workspace.join("real"), workspace.join("linked")).expect("symlink");

        let result = delete_workspace_path_blocking(
            "linked/note.txt".to_string(),
            false,
            Some(workspace.to_string_lossy().into_owned()),
            journal,
            Some(context("symlink-delete")),
        )
        .expect("delete");

        assert!(!result.ok);
        assert_eq!(
            fs::read_to_string(workspace.join("real/note.txt")).unwrap(),
            "keep"
        );
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }
}
