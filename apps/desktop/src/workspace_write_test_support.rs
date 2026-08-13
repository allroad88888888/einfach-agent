//! 写入测试共用的一次性 workspace 夹具。

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

// (base, workspace)：base 唯一且 canonicalize；workspace = base/ws 也 canonicalize。
pub(super) fn unique_workspace() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut base = std::env::temp_dir();
    base.push(format!("ws_write_it_{}_{}", std::process::id(), seq));
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
