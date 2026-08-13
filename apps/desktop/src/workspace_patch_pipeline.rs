//! 阻塞式补丁主流程：暂存、拒绝汇总、journal 预留、提交与收尾。

use super::commit::commit_changes;
use super::operation::{operation_name, operation_path, PatchOperation};
use super::path::display_path;
use super::perf::WorkspacePatchPerf;
use super::result::{PatchFileChange, RejectedOperation, WorkspacePatchResult};
use super::stage::{changed_paths, stage_operation, FileState};
use crate::workspace_change_journal::{
    discard_prepared_change, mark_change_applied, prepare_change_set, ChangeFileInput,
    WorkspaceChangeContext,
};
use crate::workspace_common::{compute_change_summary, resolve_workspace_root};
use std::{collections::HashMap, path::PathBuf};

#[cfg(test)]
pub(super) fn apply_workspace_patch_blocking(
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

pub(super) fn apply_workspace_patch_blocking_with_journal(
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
            changes: Vec::new(),
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
    let changes = changed_paths
        .iter()
        .filter_map(|path| {
            let state = files.get(path)?;
            Some(PatchFileChange {
                path: display_path(&root, path),
                created: state.initial.is_none() && state.current.is_some(),
                deleted: state.current.is_none(),
                change_summary: state
                    .current
                    .as_deref()
                    .map(|after| compute_change_summary(state.initial.as_deref(), after)),
            })
        })
        .collect::<Vec<_>>();

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
        changes,
        rejected,
        dry_run,
        would_change,
        summary,
        change_set: prepared_change.map(|(_, summary)| summary),
    })
}

#[cfg(test)]
#[path = "workspace_patch_pipeline_tests.rs"]
mod tests;
