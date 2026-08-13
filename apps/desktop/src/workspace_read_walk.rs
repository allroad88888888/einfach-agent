//! 目录遍历时的条目枚举顺序与跳过规则。

use super::limits::EXCLUDED_DIR_NAMES;
use super::paths::display_path;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) fn sorted_read_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let read_dir = fs::read_dir(dir)
        .map_err(|err| format!("failed to read directory `{}`: {err}", display_path(dir)))?;
    for entry in read_dir {
        let entry = entry.map_err(|err| {
            format!(
                "failed to read directory entry in `{}`: {err}",
                display_path(dir)
            )
        })?;
        paths.push(entry.path());
    }
    paths.sort_by(|a, b| relative_sort_key(a).cmp(&relative_sort_key(b)));
    Ok(paths)
}

fn relative_sort_key(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub(super) fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| EXCLUDED_DIR_NAMES.contains(&name))
        .unwrap_or(false)
}

pub(super) fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.starts_with('.') && name != "." && name != "..")
        .unwrap_or(false)
}
