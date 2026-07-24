use crate::workspace_change_journal::{
    copy_path, discard_prepared_change, journal_dir, mark_change_applied, move_path,
    path_fingerprint, prepare_created_path_change, prepare_relocated_path_change,
    WorkspaceChangeContext, WorkspaceChangeSummary,
};
use crate::workspace_common::resolve_workspace_root;
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathOperationResult {
    ok: bool,
    source: String,
    destination: String,
    operation: String,
    reversible: bool,
    error: Option<String>,
    change_set: Option<WorkspaceChangeSummary>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn copy_workspace_path(
    app: tauri::AppHandle,
    source: String,
    destination: String,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspacePathOperationResult, String> {
    let journal = journal_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        operate(
            "copy",
            source,
            destination,
            workspace_root,
            journal,
            change_context,
        )
    })
    .await
    .map_err(|err| format!("workspace copy worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn move_workspace_path(
    app: tauri::AppHandle,
    source: String,
    destination: String,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspacePathOperationResult, String> {
    let journal = journal_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        operate(
            "move",
            source,
            destination,
            workspace_root,
            journal,
            change_context,
        )
    })
    .await
    .map_err(|err| format!("workspace move worker failed: {err}"))?
}

fn operate(
    operation: &str,
    source_arg: String,
    destination_arg: String,
    workspace_root_arg: Option<String>,
    journal: PathBuf,
    change_context: Option<WorkspaceChangeContext>,
) -> Result<WorkspacePathOperationResult, String> {
    let fail = |error: String| WorkspacePathOperationResult {
        ok: false,
        source: source_arg.clone(),
        destination: destination_arg.clone(),
        operation: operation.to_string(),
        reversible: false,
        error: Some(error),
        change_set: None,
    };
    let root = match resolve_workspace_root(workspace_root_arg.as_deref()) {
        Ok(root) => root,
        Err(error) => return Ok(fail(error)),
    };
    let source = match resolve_source(&root, &source_arg) {
        Ok(path) => path,
        Err(error) => return Ok(fail(error)),
    };
    let destination = match resolve_destination(&root, &destination_arg) {
        Ok(path) => path,
        Err(error) => return Ok(fail(error)),
    };
    if source == destination {
        return Ok(fail("source and destination must differ".to_string()));
    }
    let Some(context) = change_context else {
        return Ok(fail(
            "path operation requires runtime change context".to_string(),
        ));
    };
    let fingerprint = match path_fingerprint(&source) {
        Ok(value) => value,
        Err(error) => return Ok(fail(error)),
    };
    let source_relative = relative(&root, &source);
    let destination_relative = relative(&root, &destination);
    if source_relative == ".git"
        || source_relative.starts_with(".git/")
        || destination_relative == ".git"
        || destination_relative.starts_with(".git/")
    {
        return Ok(fail("path operations refuse Git metadata".to_string()));
    }
    let change_id = context.change_id.clone();
    let prepared = if operation == "copy" {
        prepare_created_path_change(
            &journal,
            context,
            &root,
            destination_relative.clone(),
            fingerprint,
        )
    } else {
        prepare_relocated_path_change(
            &journal,
            context,
            &root,
            source_relative.clone(),
            destination_relative.clone(),
            fingerprint,
        )
    };
    let change_set = match prepared {
        Ok(value) => value,
        Err(error) => return Ok(fail(error)),
    };
    let applied = if operation == "copy" {
        copy_path(&source, &destination)
    } else {
        move_path(&source, &destination)
    };
    if let Err(error) = applied {
        discard_prepared_change(&journal, &change_id);
        return Ok(fail(error));
    }
    if let Err(error) = mark_change_applied(&journal, &change_id) {
        let _ = if operation == "copy" {
            remove_path(&destination)
        } else {
            move_path(&destination, &source)
        };
        discard_prepared_change(&journal, &change_id);
        return Ok(fail(error));
    }
    Ok(WorkspacePathOperationResult {
        ok: true,
        source: source_relative,
        destination: destination_relative,
        operation: operation.to_string(),
        reversible: true,
        error: None,
        change_set: Some(change_set),
    })
}

fn clean_relative(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("path must be a non-empty workspace-relative path without `..`".to_string());
    }
    Ok(path)
}

fn resolve_source(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let path = root.join(clean_relative(raw)?);
    let canonical = fs::canonicalize(&path)
        .map_err(|err| format!("failed to resolve source `{}`: {err}", path.display()))?;
    if !canonical.starts_with(root) {
        return Err("source escaped workspace root".to_string());
    }
    Ok(canonical)
}

fn resolve_destination(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let path = root.join(clean_relative(raw)?);
    if fs::symlink_metadata(&path).is_ok() {
        return Err("destination already exists".to_string());
    }
    let mut ancestor = path.parent();
    while let Some(parent) = ancestor {
        if parent.exists() {
            let canonical = fs::canonicalize(parent)
                .map_err(|err| format!("failed to resolve destination parent: {err}"))?;
            if !canonical.starts_with(root) {
                return Err("destination escaped workspace root".to_string());
            }
            break;
        }
        ancestor = parent.parent();
    }
    Ok(path)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("failed to inspect `{}`: {err}", path.display()))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|err| format!("failed to remove `{}`: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_change_journal::{revert_change_set_blocking, WorkspaceChangeContext};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn roots() -> (PathBuf, PathBuf) {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "workspace_path_operation_test_{}_{}",
            std::process::id(),
            sequence
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
    fn copy_path_returns_a_change_set_that_removes_the_copy_on_revert() {
        let (workspace, journal) = roots();
        fs::write(workspace.join("source.txt"), "content").expect("seed source");

        let result = operate(
            "copy",
            "source.txt".to_string(),
            "nested/copied.txt".to_string(),
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("copy-1")),
        )
        .expect("copy");

        assert!(result.ok);
        assert!(result.reversible);
        assert_eq!(
            fs::read_to_string(workspace.join("nested/copied.txt")).unwrap(),
            "content"
        );
        let reverted =
            revert_change_set_blocking(&journal, "copy-1", false, &workspace).expect("revert");
        assert!(reverted.ok);
        assert!(workspace.join("source.txt").exists());
        assert!(!workspace.join("nested/copied.txt").exists());
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }

    #[test]
    fn move_path_returns_a_change_set_that_restores_the_source_on_revert() {
        let (workspace, journal) = roots();
        fs::create_dir_all(workspace.join("source")).expect("create source");
        fs::write(workspace.join("source/file.txt"), "content").expect("seed source");

        let result = operate(
            "move",
            "source".to_string(),
            "nested/moved".to_string(),
            Some(workspace.to_string_lossy().into_owned()),
            journal.clone(),
            Some(context("move-1")),
        )
        .expect("move");

        assert!(result.ok);
        assert!(!workspace.join("source").exists());
        assert!(workspace.join("nested/moved/file.txt").exists());
        let reverted =
            revert_change_set_blocking(&journal, "move-1", false, &workspace).expect("revert");
        assert!(reverted.ok);
        assert_eq!(
            fs::read_to_string(workspace.join("source/file.txt")).unwrap(),
            "content"
        );
        assert!(!workspace.join("nested/moved").exists());
        let _ = fs::remove_dir_all(workspace.parent().expect("base"));
    }
}
