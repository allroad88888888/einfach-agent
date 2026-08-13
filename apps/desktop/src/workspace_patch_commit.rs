//! 暂存结果的落盘提交，以及中途失败时逆序还原已应用项。

use super::fs_ops::{apply_executable_bit, delete_file_if_present, write_text_file};
use super::stage::FileState;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub(super) fn commit_changes(
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
            Some(content) => write_text_file(root, path, content).and_then(|()| {
                match state.executable {
                    Some(executable) => apply_executable_bit(path, executable),
                    None => Ok(()),
                }
            }),
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
