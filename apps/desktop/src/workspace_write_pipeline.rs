//! 阻塞式写入主流程：校验、取锁、读旧内容、守卫、journal 预留、落盘与收尾。

use super::base64::decode_base64;
use super::before::{read_before_content, BeforeContent};
use super::compaction::maybe_compact_subagent_index;
use super::fs_ops::{apply_executable_bit, write_append, write_create};
use super::guard::verify_expected_content;
use super::limits::REVERSIBLE_MAX_BYTES;
use super::lock::{path_lock, ArchivePathLock};
use super::options::{
    normalize_max_bytes, parse_encoding, parse_mode, ContentEncoding, WriteMode,
};
use super::perf::WorkspaceWritePerf;
use super::result::{error_result, WorkspaceWriteResult};
use super::target_path::{relative_path, resolve_workspace_path};
use crate::workspace_change_journal::{
    discard_prepared_change, mark_change_applied, prepare_change_set, ChangeFileInput,
    WorkspaceChangeContext,
};
use crate::workspace_common::{atomic_write, compute_change_summary, resolve_workspace_root};
use std::{fs, path::PathBuf};

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn write_workspace_file_blocking(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
) -> Result<WorkspaceWriteResult, String> {
    write_workspace_file_blocking_with_journal(
        path,
        content,
        mode,
        expected_old_content,
        None,
        create_dirs,
        max_bytes,
        exclusive_path_lock,
        workspace_root_arg,
        None,
        None,
        None,
        None,
        "workspace-write-test".to_string(),
    )
}

/// Test entry point for the options that are not part of the legacy positional helper.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn write_workspace_file_blocking_with_options(
    path: String,
    content: String,
    mode: Option<String>,
    workspace_root_arg: Option<String>,
    encoding: Option<String>,
    executable: Option<bool>,
    dry_run: Option<bool>,
) -> Result<WorkspaceWriteResult, String> {
    write_workspace_file_blocking_with_journal(
        path,
        content,
        mode,
        None,
        None,
        None,
        None,
        None,
        workspace_root_arg,
        encoding,
        executable,
        dry_run,
        None,
        "workspace-write-test".to_string(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn write_workspace_file_blocking_with_journal(
    path: String,
    content: String,
    mode: Option<String>,
    expected_old_content: Option<String>,
    expected_content_hash: Option<String>,
    create_dirs: Option<bool>,
    max_bytes: Option<usize>,
    exclusive_path_lock: Option<bool>,
    workspace_root_arg: Option<String>,
    encoding: Option<String>,
    executable: Option<bool>,
    dry_run: Option<bool>,
    journal: Option<(PathBuf, WorkspaceChangeContext)>,
    diagnostic_operation_id: String,
) -> Result<WorkspaceWriteResult, String> {
    let dry_run = dry_run.unwrap_or(false);
    let mut perf = WorkspaceWritePerf::new(
        diagnostic_operation_id,
        content.len(),
        mode.as_deref(),
        exclusive_path_lock.unwrap_or(false),
        journal.is_some(),
    );
    let result = (|| -> Result<WorkspaceWriteResult, String> {
        let mode = match parse_mode(mode.as_deref()) {
            Ok(mode) => mode,
            Err(err) => return Ok(error_result(&path, err)),
        };
        let encoding = match parse_encoding(encoding.as_deref()) {
            Ok(encoding) => encoding,
            Err(err) => return Ok(error_result(&path, err)),
        };
        let guard_requested = expected_old_content.is_some() || expected_content_hash.is_some();
        // Append accepts guards too: without one, a retried chunked append cannot tell
        // "my write was lost" from "my write landed", so it can only duplicate content.
        if mode == WriteMode::Create && guard_requested {
            return Ok(error_result(
                &path,
                "optimistic guards are not valid with mode \"create\"; the file must not exist",
            ));
        }
        if expected_old_content.is_some() && expected_content_hash.is_some() {
            return Ok(error_result(
                &path,
                "pass either expectedOldContent or expectedContentHash, not both",
            ));
        }

        // One byte view for every mode; text-ness decides diffing and reversibility.
        let payload = match encoding {
            ContentEncoding::Utf8 => content.clone().into_bytes(),
            ContentEncoding::Base64 => match decode_base64(&content) {
                Ok(bytes) => bytes,
                Err(err) => return Ok(error_result(&path, err)),
            },
        };
        let payload_text = match encoding {
            ContentEncoding::Utf8 => Some(content.clone()),
            // Base64 is how binary arrives, but it is also a legitimate way to send text.
            // Recovering the text keeps diffs and rollback working for that case.
            ContentEncoding::Base64 => {
                String::from_utf8(payload.clone())
                    .ok()
                    .filter(|text| !text.contains('\0'))
            }
        };

        let max_bytes = normalize_max_bytes(max_bytes);
        let bytes = payload.len();
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
        perf.phase("validate_and_resolve");

        if let Some(parent) = target_path.parent() {
            if !parent.exists() {
                // Defaults to true, matching apply_patch. A missing parent directory
                // was the single most common first-write failure.
                if create_dirs.unwrap_or(true) {
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
        perf.phase("prepare_parent");

        let _path_lock = if exclusive_path_lock.unwrap_or(false) {
            match ArchivePathLock::acquire(&target_path) {
                Ok(lock) => Some(lock),
                Err(err) => return Ok(error_result(&display_path, err)),
            }
        } else {
            None
        };
        perf.phase("exclusive_lock");

        if mode == WriteMode::Append && exclusive_path_lock.unwrap_or(false) {
            if let Err(err) = maybe_compact_subagent_index(&target_path) {
                return Ok(error_result(&display_path, err));
            }
        }
        perf.phase("archive_compaction");

        // Everything from here to the write is one critical section. The previous
        // content is read exactly once and shared by the optimistic guard, the
        // rollback journal and the change summary, so the guard can no longer pass
        // against content that a concurrent write in this process already replaced.
        let process_lock = path_lock(&target_path);
        let _process_guard = process_lock.lock().unwrap_or_else(|err| err.into_inner());
        perf.phase("path_lock");

        // Append never needs the old bytes for its own sake; only the journal does.
        let needs_before = journal.is_some()
            || guard_requested
            || matches!(mode, WriteMode::Overwrite | WriteMode::Upsert);
        let before = if needs_before {
            read_before_content(&target_path)
        } else {
            BeforeContent::Missing
        };
        let existed = if needs_before {
            before.existed()
        } else {
            target_path.exists()
        };
        perf.phase("read_before");

        // `upsert` collapses the read-probe round trip: it creates when absent and
        // overwrites when present, so callers do not have to know which it is.
        let effective_mode = match mode {
            WriteMode::Upsert if existed => WriteMode::Overwrite,
            WriteMode::Upsert => WriteMode::Create,
            other => other,
        };

        if mode == WriteMode::Overwrite && !existed {
            return Ok(error_result(
                &display_path,
                "cannot overwrite a file that does not exist; use mode \"upsert\" to create it when absent",
            ));
        }
        if effective_mode == WriteMode::Overwrite || (effective_mode == WriteMode::Append && existed)
        {
            if let Err(error) = verify_expected_content(
                &before,
                expected_old_content.as_deref(),
                expected_content_hash.as_deref(),
            ) {
                return Ok(error_result(&display_path, error));
            }
        } else if guard_requested {
            // Reached only via `upsert` on a missing file: the caller asserted a
            // specific previous state, so creating a fresh file would silently
            // discard that intent.
            return Ok(error_result(
                &display_path,
                "optimistic guard was provided but the file does not exist; drop the guard to create it",
            ));
        }
        perf.phase("verify_guard");

        // The full post-write content, when it is representable as text. `None` means
        // binary (or an unreadable previous file), which is exactly the condition that
        // makes a write non-reversible and undiffable.
        let after_text = match effective_mode {
            WriteMode::Create | WriteMode::Overwrite => payload_text.clone(),
            WriteMode::Append => match (&before, &payload_text) {
                (_, None) => None,
                (BeforeContent::Missing, Some(appended)) => Some(appended.clone()),
                (BeforeContent::Text(existing), Some(appended)) => {
                    Some(format!("{existing}{appended}"))
                }
                (BeforeContent::Unsupported(_), _) => None,
            },
            WriteMode::Upsert => unreachable!("upsert is resolved into create/overwrite above"),
        };

        // Reversibility is a property of the content, not a precondition for writing.
        // Binary artifacts and oversized files used to be rejected outright; now they
        // are written and reported as non-reversible, so the capability exists and the
        // limitation is visible instead of silent.
        let reversible_reason: Option<String> = match (&before, &after_text) {
            (BeforeContent::Unsupported(reason), _) => Some(reason.clone()),
            (_, None) => Some("binary content is not reversible".to_string()),
            (_, Some(after)) if after.len() > REVERSIBLE_MAX_BYTES => Some(format!(
                "resulting file exceeds the reversible {REVERSIBLE_MAX_BYTES} byte limit"
            )),
            _ => None,
        };

        let prepared_change = match (journal.as_ref(), &reversible_reason, &after_text) {
            (Some((directory, context)), None, Some(after)) => {
                let journal_before = before.text().map(str::to_string);
                match prepare_change_set(
                    directory,
                    context.clone(),
                    &workspace_root,
                    vec![ChangeFileInput {
                        path: display_path.clone(),
                        before: journal_before,
                        after: Some(after.clone()),
                    }],
                ) {
                    Ok(summary) => Some((directory.clone(), summary)),
                    Err(error) => return Ok(error_result(&display_path, error)),
                }
            }
            _ => None,
        };
        perf.phase("journal_prepare");

        let change_summary = match (&before, &after_text) {
            (_, None) => None,
            (BeforeContent::Text(previous), Some(after)) => {
                Some(compute_change_summary(Some(previous), after))
            }
            (BeforeContent::Missing, Some(after)) if !existed => {
                Some(compute_change_summary(None, after))
            }
            _ => None,
        };

        // dry_run stops here: every check that could reject the write has already run,
        // so the caller learns whether it would be accepted and what it would change.
        if dry_run {
            if let Some((directory, summary)) = prepared_change.as_ref() {
                discard_prepared_change(directory, &summary.id);
            }
            let would_change = change_summary
                .as_ref()
                .map(|summary| summary.lines_added > 0 || summary.lines_removed > 0)
                .unwrap_or(true);
            perf.phase("dry_run");
            return Ok(WorkspaceWriteResult {
                ok: true,
                path: display_path,
                bytes_written: 0,
                created: !existed,
                overwritten: effective_mode == WriteMode::Overwrite,
                appended: effective_mode == WriteMode::Append,
                error: None,
                change_set: None,
                change_summary,
                reversible: reversible_reason.is_none(),
                reversible_reason,
                dry_run: true,
                would_change,
            });
        }

        let write_result = match effective_mode {
            // `create` keeps O_EXCL: refusing an existing file is the whole point of
            // the mode, and a rename would defeat it.
            WriteMode::Create => write_create(&target_path, &payload),
            // Overwrite goes through a temp file + rename so a crash mid-write can
            // never leave the target truncated or half-written.
            WriteMode::Overwrite => atomic_write(&target_path, &payload),
            WriteMode::Append => write_append(&target_path, &payload),
            WriteMode::Upsert => unreachable!("upsert is resolved into create/overwrite above"),
        }
        .and_then(|()| match executable {
            Some(executable) => apply_executable_bit(&target_path, executable),
            None => Ok(()),
        });
        perf.phase("file_write");

        let result = match write_result {
            Ok(()) => {
                if let Some((directory, summary)) = prepared_change.as_ref() {
                    if let Err(error) = mark_change_applied(directory, &summary.id) {
                        log::warn!("failed to mark workspace change as applied: {error}");
                    }
                }
                Ok(WorkspaceWriteResult {
                    ok: true,
                    path: display_path,
                    bytes_written: bytes,
                    created: !existed,
                    overwritten: effective_mode == WriteMode::Overwrite,
                    appended: effective_mode == WriteMode::Append,
                    error: None,
                    change_set: prepared_change.map(|(_, summary)| summary),
                    change_summary,
                    reversible: reversible_reason.is_none(),
                    reversible_reason,
                    dry_run: false,
                    would_change: true,
                })
            }
            Err(err) => {
                if let Some((directory, summary)) = prepared_change.as_ref() {
                    discard_prepared_change(directory, &summary.id);
                }
                Ok(error_result(&display_path, err))
            }
        };
        perf.phase("journal_finalize");
        result
    })();
    perf.finish(&result);
    result
}

#[cfg(test)]
#[path = "workspace_write_pipeline_tests.rs"]
mod tests;

// 跨语言对拍：喂 packages/host-node/fixtures/write-limits.json。驱动器必须住在这里而不是顶层，
// `write_workspace_file_blocking_with_journal` 是 pub(super)。
#[cfg(test)]
#[path = "workspace_write_pipeline_parity_tests.rs"]
mod parity_tests;
