//! 变更日志测试共用的一次性 workspace 与 journal 目录夹具。

use super::types::WorkspaceChangeContext;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{fs, path::PathBuf};

pub(super) fn roots() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "workspace_change_test_{}_{}",
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

pub(super) fn context(id: &str) -> WorkspaceChangeContext {
    WorkspaceChangeContext {
        change_id: id.to_string(),
        session_id: "session".to_string(),
        run_id: "run".to_string(),
        tool_call_id: "call".to_string(),
    }
}
