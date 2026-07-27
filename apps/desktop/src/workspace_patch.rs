use crate::workspace_change_journal::{
    discard_prepared_change, journal_dir, mark_change_applied, prepare_change_set, ChangeFileInput,
    WorkspaceChangeContext, WorkspaceChangeSummary,
};
use crate::workspace_common::resolve_workspace_root;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MAX_FILE_BYTES: usize = 1024 * 1024;
const PERF_LOG_TARGET: &str = "web_agent::perf";

struct WorkspacePatchPerf {
    operation_id: String,
    started_at: Instant,
    phase_started_at: Instant,
    finished: bool,
}

impl WorkspacePatchPerf {
    fn new(
        operation_id: String,
        operation_count: usize,
        dry_run: bool,
        journal_enabled: bool,
    ) -> Self {
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.start operation_id={} operation_count={} dry_run={} journal_enabled={}",
            operation_id,
            operation_count,
            dry_run,
            journal_enabled,
        );
        let now = Instant::now();
        Self {
            operation_id,
            started_at: now,
            phase_started_at: now,
            finished: false,
        }
    }

    fn phase(&mut self, phase: &str) {
        let now = Instant::now();
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.phase operation_id={} phase={} phase_ms={:.1} total_ms={:.1}",
            self.operation_id,
            phase,
            now.duration_since(self.phase_started_at).as_secs_f64() * 1000.0,
            now.duration_since(self.started_at).as_secs_f64() * 1000.0,
        );
        self.phase_started_at = now;
    }

    fn finish(&mut self, status: &str, changed_file_count: usize, rejected_count: usize) {
        self.finished = true;
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.finish operation_id={} status={} duration_ms={:.1} changed_file_count={} rejected_count={}",
            self.operation_id,
            status,
            self.started_at.elapsed().as_secs_f64() * 1000.0,
            changed_file_count,
            rejected_count,
        );
    }
}

impl Drop for WorkspacePatchPerf {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        log::error!(
            target: PERF_LOG_TARGET,
            "workspace_patch.finish operation_id={} status=error duration_ms={:.1}",
            self.operation_id,
            self.started_at.elapsed().as_secs_f64() * 1000.0,
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PatchOperation {
    AddFile {
        path: String,
        content: String,
    },
    DeleteFile {
        path: String,
        #[serde(rename = "oldContent")]
        old_content: Option<String>,
    },
    Replace {
        path: String,
        #[serde(rename = "oldText")]
        old_text: String,
        #[serde(rename = "newText")]
        new_text: String,
        #[serde(rename = "expectedReplacements")]
        expected_replacements: Option<i64>,
    },
    OverwriteFile {
        path: String,
        content: String,
        #[serde(rename = "oldContent")]
        old_content: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchResult {
    ok: bool,
    changed_files: Vec<String>,
    rejected: Vec<RejectedOperation>,
    dry_run: bool,
    would_change: bool,
    summary: String,
    change_set: Option<WorkspaceChangeSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedOperation {
    index: usize,
    operation: String,
    path: Option<String>,
    reason: String,
}

#[derive(Clone)]
struct FileState {
    initial: Option<String>,
    current: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn apply_workspace_patch(
    app: tauri::AppHandle,
    operations: Vec<PatchOperation>,
    dry_run: Option<bool>,
    workspace_root: Option<String>,
    change_context: Option<WorkspaceChangeContext>,
    diagnostic_operation_id: Option<String>,
) -> Result<WorkspacePatchResult, String> {
    let operation_id = diagnostic_operation_id
        .or_else(|| {
            change_context
                .as_ref()
                .map(|context| context.change_id.clone())
        })
        .unwrap_or_else(|| {
            format!(
                "workspace-patch-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        });
    let journal_resolve_started_at = Instant::now();
    let journal = change_context
        .map(|context| journal_dir(&app).map(|directory| (directory, context)))
        .transpose()?;
    log::info!(
        target: PERF_LOG_TARGET,
        "workspace_patch.host operation_id={} phase=journal_resolve phase_ms={:.1}",
        operation_id,
        journal_resolve_started_at.elapsed().as_secs_f64() * 1000.0,
    );
    tauri::async_runtime::spawn_blocking(move || {
        apply_workspace_patch_blocking_with_journal(
            operations,
            dry_run.unwrap_or(false),
            workspace_root,
            journal,
            operation_id,
        )
    })
    .await
    .map_err(|err| format!("workspace patch worker failed: {err}"))?
}

#[cfg(test)]
fn apply_workspace_patch_blocking(
    operations: Vec<PatchOperation>,
    dry_run: bool,
    workspace_root: Option<String>,
) -> Result<WorkspacePatchResult, String> {
    apply_workspace_patch_blocking_with_journal(
        operations,
        dry_run,
        workspace_root,
        None,
        "workspace-patch-test".to_string(),
    )
}

fn apply_workspace_patch_blocking_with_journal(
    operations: Vec<PatchOperation>,
    dry_run: bool,
    workspace_root: Option<String>,
    journal: Option<(PathBuf, WorkspaceChangeContext)>,
    diagnostic_operation_id: String,
) -> Result<WorkspacePatchResult, String> {
    let mut perf = WorkspacePatchPerf::new(
        diagnostic_operation_id,
        operations.len(),
        dry_run,
        journal.is_some(),
    );
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    perf.phase("resolve_workspace");
    let mut files: HashMap<PathBuf, FileState> = HashMap::new();
    let mut rejected = Vec::new();

    for (index, operation) in operations.iter().enumerate() {
        if let Err(reason) = stage_operation(&root, &mut files, operation) {
            rejected.push(RejectedOperation {
                index,
                operation: operation_name(operation).to_string(),
                path: Some(operation_path(operation).to_string()),
                reason,
            });
        }
    }
    perf.phase("stage_operations");

    if !rejected.is_empty() {
        let summary = format!("rejected {} operation(s); no files changed", rejected.len());
        perf.finish("rejected", 0, rejected.len());
        return Ok(WorkspacePatchResult {
            ok: false,
            changed_files: Vec::new(),
            rejected,
            dry_run,
            would_change: false,
            summary,
            change_set: None,
        });
    }

    let changed_paths = changed_paths(&root, &files);
    let changed_files = changed_paths
        .iter()
        .map(|path| display_path(&root, path))
        .collect::<Vec<_>>();
    let would_change = !changed_files.is_empty();

    let prepared_change = if !dry_run && !changed_paths.is_empty() {
        if let Some((directory, context)) = journal.as_ref() {
            let changed = changed_paths
                .iter()
                .filter_map(|path| {
                    files.get(path).map(|state| ChangeFileInput {
                        path: display_path(&root, path),
                        before: state.initial.clone(),
                        after: state.current.clone(),
                    })
                })
                .collect();
            Some((
                directory.clone(),
                prepare_change_set(directory, context.clone(), &root, changed)?,
            ))
        } else {
            None
        }
    } else {
        None
    };
    perf.phase("journal_prepare");

    if !dry_run {
        if let Err(error) = commit_changes(&root, &changed_paths, &files) {
            if let Some((directory, summary)) = prepared_change.as_ref() {
                discard_prepared_change(directory, &summary.id);
            }
            return Err(error);
        }
    }
    perf.phase("file_commit");

    if let Some((directory, summary)) = prepared_change.as_ref() {
        if let Err(error) = mark_change_applied(directory, &summary.id) {
            log::warn!("failed to mark workspace change as applied: {error}");
        }
    }
    perf.phase("journal_finalize");

    let summary = if dry_run {
        format!("dry run: {} file(s) would change", changed_files.len())
    } else {
        format!("applied patch: {} file(s) changed", changed_files.len())
    };

    perf.finish("ok", changed_files.len(), rejected.len());
    Ok(WorkspacePatchResult {
        ok: true,
        changed_files,
        rejected,
        dry_run,
        would_change,
        summary,
        change_set: prepared_change.map(|(_, summary)| summary),
    })
}

fn commit_changes(
    root: &Path,
    changed_paths: &[PathBuf],
    files: &HashMap<PathBuf, FileState>,
) -> Result<(), String> {
    let mut applied = Vec::new();

    for path in changed_paths {
        let state = files
            .get(path)
            .ok_or_else(|| format!("missing staged state for `{}`", path.display()))?;
        let result = match &state.current {
            Some(content) => write_text_file(root, path, content),
            None => delete_file_if_present(path),
        };

        if let Err(err) = result {
            if let Err(rollback_err) = rollback_changes(root, &applied, files) {
                return Err(format!("{err}; {rollback_err}"));
            }
            return Err(err);
        }
        applied.push(path.clone());
    }

    Ok(())
}

fn rollback_changes(
    root: &Path,
    applied: &[PathBuf],
    files: &HashMap<PathBuf, FileState>,
) -> Result<(), String> {
    let mut rollback_errors = Vec::new();

    for path in applied.iter().rev() {
        let Some(state) = files.get(path) else {
            rollback_errors.push(format!("missing rollback state for `{}`", path.display()));
            continue;
        };
        let result = match &state.initial {
            Some(content) => write_text_file(root, path, content),
            None => delete_file_if_present(path),
        };
        if let Err(err) = result {
            rollback_errors.push(err);
        }
    }

    if rollback_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "failed to rollback partially applied patch: {}",
            rollback_errors.join("; ")
        ))
    }
}

fn stage_operation(
    root: &Path,
    files: &mut HashMap<PathBuf, FileState>,
    operation: &PatchOperation,
) -> Result<(), String> {
    match operation {
        PatchOperation::AddFile { path, content } => {
            validate_text_input("content", content)?;
            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            // P2：add_file 语义是"创建新文件"，两条守卫都要走。
            //   · current.is_some()：已暂存的当前内容还在（磁盘原有 or 本批已 add），不能重复新建。
            //   · initial.is_some()：本批开始时磁盘上就已存在该文件。哪怕中途被 delete_file 把
            //     current 置成 None，也仍拒绝 add——否则 delete+add 同路径就能绕过 overwrite_file
            //     对已存在文件要求 oldContent 的守卫，静默整文件替换。改已存在文件内容必须走 overwrite_file。
            //   合法场景不受影响：本批内新建(add)→删(delete)→再建(add) 同一路径，initial 始终为 None，仍允许。
            if state.current.is_some() {
                return Err("file already exists".to_string());
            }
            if state.initial.is_some() {
                return Err(
                    "file already exists on disk; use overwrite_file to replace an existing file"
                        .to_string(),
                );
            }
            state.current = Some(content.clone());
            Ok(())
        }
        PatchOperation::DeleteFile { path, old_content } => {
            if let Some(old_content) = old_content {
                validate_text_input("oldContent", old_content)?;
            }
            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            let Some(current) = state.current.as_ref() else {
                return Err("file does not exist".to_string());
            };
            if let Some(old_content) = old_content {
                if old_content != current {
                    return Err("oldContent did not match current file content".to_string());
                }
            }
            state.current = None;
            Ok(())
        }
        PatchOperation::Replace {
            path,
            old_text,
            new_text,
            expected_replacements,
        } => {
            validate_non_empty_text_input("oldText", old_text)?;
            validate_text_input("newText", new_text)?;
            if matches!(expected_replacements.as_ref(), Some(value) if *value <= 0) {
                return Err("expectedReplacements must be greater than 0".to_string());
            }

            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            let Some(current) = state.current.as_ref() else {
                return Err("file does not exist".to_string());
            };

            let replacement_count = current.matches(old_text).count();
            if replacement_count == 0 {
                return Err("oldText was not found".to_string());
            }

            let expected = expected_replacements
                .as_ref()
                .map(|value| *value as usize)
                .unwrap_or(1);
            if replacement_count != expected {
                return Err(format!(
                    "replacement count mismatch: expected {expected}, found {replacement_count}"
                ));
            }

            let next = current.replace(old_text, new_text);
            validate_file_text("resulting file content", &next)?;
            state.current = Some(next);
            Ok(())
        }
        PatchOperation::OverwriteFile {
            path,
            content,
            old_content,
        } => {
            validate_text_input("content", content)?;
            if let Some(old_content) = old_content {
                validate_text_input("oldContent", old_content)?;
            }

            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            if let Some(current) = state.current.as_ref() {
                let Some(old_content) = old_content else {
                    return Err(
                        "oldContent is required when overwriting an existing file".to_string()
                    );
                };
                if old_content != current {
                    return Err("oldContent did not match current file content".to_string());
                }
            }
            state.current = Some(content.clone());
            Ok(())
        }
    }
}

fn load_state<'a>(
    files: &'a mut HashMap<PathBuf, FileState>,
    path: &Path,
) -> Result<&'a mut FileState, String> {
    if !files.contains_key(path) {
        let initial = read_optional_text_file(path)?;
        files.insert(
            path.to_path_buf(),
            FileState {
                initial: initial.clone(),
                current: initial,
            },
        );
    }
    files
        .get_mut(path)
        .ok_or_else(|| format!("failed to stage `{}`", path.display()))
}

fn resolve_workspace_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
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

fn ensure_parent_inside_root(root: &Path, path: &Path) -> Result<(), String> {
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

fn read_optional_text_file(path: &Path) -> Result<Option<String>, String> {
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

fn validate_non_empty_text_input(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} must be non-empty"));
    }
    validate_text_input(label, value)
}

fn validate_text_input(label: &str, value: &str) -> Result<(), String> {
    if value.as_bytes().len() > MAX_FILE_BYTES {
        return Err(format!("{label} exceeds {} byte limit", MAX_FILE_BYTES));
    }
    if value.contains('\0') {
        return Err(format!("{label} appears to be binary"));
    }
    Ok(())
}

fn validate_file_text(label: &str, value: &str) -> Result<(), String> {
    validate_text_input(label, value)
}

fn changed_paths(root: &Path, files: &HashMap<PathBuf, FileState>) -> Vec<PathBuf> {
    let mut paths = files
        .iter()
        .filter_map(|(path, state)| {
            if state.initial != state.current {
                Some(path.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| display_path(root, path));
    paths
}

fn write_text_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
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
    fs::write(path, content).map_err(|err| format!("failed to write `{}`: {err}", path.display()))
}

fn delete_file_if_present(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|err| format!("failed to delete `{}`: {err}", path.display()))
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn operation_name(operation: &PatchOperation) -> &'static str {
    match operation {
        PatchOperation::AddFile { .. } => "add_file",
        PatchOperation::DeleteFile { .. } => "delete_file",
        PatchOperation::Replace { .. } => "replace",
        PatchOperation::OverwriteFile { .. } => "overwrite_file",
    }
}

fn operation_path(operation: &PatchOperation) -> &str {
    match operation {
        PatchOperation::AddFile { path, .. }
        | PatchOperation::DeleteFile { path, .. }
        | PatchOperation::Replace { path, .. }
        | PatchOperation::OverwriteFile { path, .. } => path,
    }
}

#[cfg(test)]
mod tests {
    // P2：只用标准库搭临时 workspace（不引 tempfile 依赖），聚焦验证 add_file 的
    // delete+add 绕过守卫已被堵死，且合法的 add→delete→add 回归仍放行。
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // 每个用例独立的临时 root（进程内 Rust 测试并发跑，用 pid+计数器避免撞目录）；
    // 返回已 canonicalize 的路径，满足 resolve_workspace_path 的 starts_with(root) 校验。
    fn unique_root() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "workspace_patch_test_{}_{}",
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).expect("create temp root");
        fs::canonicalize(&dir).expect("canonicalize temp root")
    }

    fn add(path: &str, content: &str) -> PatchOperation {
        PatchOperation::AddFile {
            path: path.to_string(),
            content: content.to_string(),
        }
    }

    fn delete(path: &str) -> PatchOperation {
        PatchOperation::DeleteFile {
            path: path.to_string(),
            old_content: None,
        }
    }

    fn replace(path: &str, old: &str, new: &str) -> PatchOperation {
        PatchOperation::Replace {
            path: path.to_string(),
            old_text: old.to_string(),
            new_text: new.to_string(),
            expected_replacements: None,
        }
    }

    fn root_arg(root: &Path) -> Option<String> {
        Some(root.to_string_lossy().into_owned())
    }

    #[test]
    fn delete_then_add_existing_file_is_rejected() {
        let root = unique_root();
        fs::write(root.join("existing.txt"), "on disk").expect("seed existing file");
        let mut files: HashMap<PathBuf, FileState> = HashMap::new();

        // 先删已存在文件（current -> None），再对同路径 add：initial 仍为 Some，必须被拒。
        stage_operation(&root, &mut files, &delete("existing.txt")).expect("delete should stage");
        let err = stage_operation(&root, &mut files, &add("existing.txt", "replaced"))
            .expect_err("add over a file that existed on disk must be rejected");
        assert!(
            err.contains("use overwrite_file"),
            "unexpected error message: {err}"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn add_delete_add_fresh_path_is_allowed() {
        let root = unique_root();
        let mut files: HashMap<PathBuf, FileState> = HashMap::new();

        // 本批内全程新建：initial 始终为 None，add→delete→add 同路径应放行。
        stage_operation(&root, &mut files, &add("fresh.txt", "first")).expect("first add");
        stage_operation(&root, &mut files, &delete("fresh.txt")).expect("delete staged add");
        stage_operation(&root, &mut files, &add("fresh.txt", "second")).expect("re-add is allowed");

        let state = files
            .get(&root.join("fresh.txt"))
            .expect("fresh.txt should be staged");
        assert_eq!(state.current.as_deref(), Some("second"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_edits_file_on_disk() {
        // 真在磁盘上跑 replace（非 dry_run）：apply 后磁盘内容真被改，changed_files 合理。
        let root = unique_root();
        fs::write(root.join("code.txt"), "const answer = 41;\n").expect("seed file");

        let result = apply_workspace_patch_blocking(
            vec![replace("code.txt", "41", "42")],
            false,
            root_arg(&root),
        )
        .expect("patch worker should not error");
        assert!(result.ok, "replace 应成功，rejected: {:?}", result.rejected);
        assert_eq!(result.changed_files, vec!["code.txt".to_string()]);

        let on_disk = fs::read_to_string(root.join("code.txt")).expect("read back");
        assert_eq!(on_disk, "const answer = 42;\n", "磁盘内容应被真替换");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dry_run_does_not_touch_disk() {
        // dry_run：would_change 为真但磁盘不变。
        let root = unique_root();
        fs::write(root.join("code.txt"), "value = 1\n").expect("seed file");

        let result = apply_workspace_patch_blocking(
            vec![replace("code.txt", "1", "2")],
            true,
            root_arg(&root),
        )
        .expect("patch worker should not error");
        assert!(result.ok);
        assert!(result.would_change, "dry_run 应报告 would_change");

        let on_disk = fs::read_to_string(root.join("code.txt")).expect("read back");
        assert_eq!(on_disk, "value = 1\n", "dry_run 不应改磁盘");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_outside_workspace_is_rejected() {
        // confine：replace 一个 ../ 越界路径 → 被拒(rejected 非空、ok=false)。
        let root = unique_root();
        let result = apply_workspace_patch_blocking(
            vec![replace("../evil.txt", "a", "b")],
            false,
            root_arg(&root),
        )
        .expect("patch worker should not error");
        assert!(!result.ok, "越界 replace 必须失败");
        assert!(!result.rejected.is_empty(), "应有 rejected 记录");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn successful_patch_returns_persisted_change_set() {
        let root = unique_root();
        let journal = root.join(".journal");
        fs::write(root.join("code.txt"), "before").expect("seed file");
        let result = apply_workspace_patch_blocking_with_journal(
            vec![replace("code.txt", "before", "after")],
            false,
            root_arg(&root),
            Some((
                journal.clone(),
                WorkspaceChangeContext {
                    change_id: "patch-change".to_string(),
                    session_id: "session".to_string(),
                    run_id: "run".to_string(),
                    tool_call_id: "call".to_string(),
                },
            )),
            "patch-change".to_string(),
        )
        .expect("apply journaled patch");

        assert_eq!(
            result.change_set.as_ref().map(|change| change.id.as_str()),
            Some("patch-change")
        );
        assert!(journal.join("patch-change.json").is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
