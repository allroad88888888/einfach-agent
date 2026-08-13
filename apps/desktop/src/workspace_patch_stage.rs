//! 把补丁操作暂存进内存文件状态表，并挑出真正发生变化的路径。

use super::fs_ops::read_optional_text_file;
use super::guard::verify_staged_guard;
use super::limits::{validate_file_text, validate_non_empty_text_input, validate_text_input};
use super::operation::PatchOperation;
use super::path::{display_path, resolve_workspace_path};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(super) struct FileState {
    pub(super) initial: Option<String>,
    pub(super) current: Option<String>,
    /// Explicit executable request from the last operation that set one.
    pub(super) executable: Option<bool>,
}

pub(super) fn stage_operation(
    root: &Path,
    files: &mut HashMap<PathBuf, FileState>,
    operation: &PatchOperation,
) -> Result<(), String> {
    match operation {
        PatchOperation::AddFile {
            path,
            content,
            executable,
        } => {
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
            if executable.is_some() {
                state.executable = *executable;
            }
            Ok(())
        }
        PatchOperation::DeleteFile {
            path,
            old_content,
            expected_content_hash,
        } => {
            if let Some(old_content) = old_content {
                validate_text_input("oldContent", old_content)?;
            }
            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            let Some(current) = state.current.as_ref() else {
                return Err("file does not exist".to_string());
            };
            verify_staged_guard(
                current,
                old_content.as_deref(),
                expected_content_hash.as_deref(),
            )?;
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
            expected_content_hash,
            executable,
        } => {
            validate_text_input("content", content)?;
            if let Some(old_content) = old_content {
                validate_text_input("oldContent", old_content)?;
            }

            let path = resolve_workspace_path(root, path)?;
            let state = load_state(files, &path)?;
            if let Some(current) = state.current.as_ref() {
                // Replacing an existing file still demands proof it was read first;
                // expectedContentHash is the cheap way to give that proof.
                if old_content.is_none() && expected_content_hash.is_none() {
                    return Err(
                        "oldContent or expectedContentHash is required when overwriting an \
                         existing file"
                            .to_string(),
                    );
                }
                let current = current.clone();
                verify_staged_guard(
                    &current,
                    old_content.as_deref(),
                    expected_content_hash.as_deref(),
                )?;
            }
            state.current = Some(content.clone());
            if executable.is_some() {
                state.executable = *executable;
            }
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
                executable: None,
            },
        );
    }
    files
        .get_mut(path)
        .ok_or_else(|| format!("failed to stage `{}`", path.display()))
}

pub(super) fn changed_paths(root: &Path, files: &HashMap<PathBuf, FileState>) -> Vec<PathBuf> {
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

#[cfg(test)]
#[path = "workspace_patch_stage_tests.rs"]
mod tests;
