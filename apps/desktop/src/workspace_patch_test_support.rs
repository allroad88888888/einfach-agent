//! 补丁测试共用的一次性 workspace 与补丁操作构造。

use super::operation::PatchOperation;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
};

// 每个用例独立的临时 root（进程内 Rust 测试并发跑，用 pid+计数器避免撞目录）；
// 返回已 canonicalize 的路径，满足 resolve_workspace_path 的 starts_with(root) 校验。
pub(super) fn unique_root() -> PathBuf {
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

pub(super) fn add(path: &str, content: &str) -> PatchOperation {
    PatchOperation::AddFile {
        path: path.to_string(),
        content: content.to_string(),
        executable: None,
    }
}

pub(super) fn delete(path: &str) -> PatchOperation {
    PatchOperation::DeleteFile {
        path: path.to_string(),
        old_content: None,
        expected_content_hash: None,
    }
}

pub(super) fn overwrite(
    path: &str,
    content: &str,
    old_content: Option<&str>,
    expected_content_hash: Option<&str>,
) -> PatchOperation {
    PatchOperation::OverwriteFile {
        path: path.to_string(),
        content: content.to_string(),
        old_content: old_content.map(str::to_string),
        expected_content_hash: expected_content_hash.map(str::to_string),
        executable: None,
    }
}

pub(super) fn replace(path: &str, old: &str, new: &str) -> PatchOperation {
    PatchOperation::Replace {
        path: path.to_string(),
        old_text: old.to_string(),
        new_text: new.to_string(),
        expected_replacements: None,
    }
}

pub(super) fn root_arg(root: &Path) -> Option<String> {
    Some(root.to_string_lossy().into_owned())
}
