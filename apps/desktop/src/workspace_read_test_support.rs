//! 真读磁盘的集成测试共用的临时 workspace 构造。

// 真读磁盘的集成测试：用 fs::write 造真文件，显式把该目录作为 workspace_root 传入 *_blocking，
// 验证 read/list/search 真读到内容，以及 confine（../、workspace 外绝对路径、文件系统根 `/`）在真实路径下被拒。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
};

// 返回 (base, workspace)：base 唯一且 canonicalize；workspace = base/ws 也 canonicalize
//（满足 resolve_workspace_path 的 starts_with(root) 校验）。base 用于放 workspace 外的"越界目标"文件。
pub(super) fn unique_workspace() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut base = std::env::temp_dir();
    base.push(format!("ws_read_it_{}_{}", std::process::id(), seq));
    fs::create_dir_all(&base).expect("create base");
    let base = fs::canonicalize(&base).expect("canonicalize base");
    let ws = base.join("ws");
    fs::create_dir_all(&ws).expect("create ws");
    let ws = fs::canonicalize(&ws).expect("canonicalize ws");
    (base, ws)
}

pub(super) fn root_arg(ws: &Path) -> Option<String> {
    Some(ws.to_string_lossy().into_owned())
}
