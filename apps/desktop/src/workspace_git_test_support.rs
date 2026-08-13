//! workspace git 测试共用的临时 git 仓库搭建与命令行参数构造。

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

// 真 git 仓库的临时 workspace：唯一目录 + git init + 初始提交。返回 canonicalize 后的 root。
// 两个带独特标记的文件先提交为基线，供后续改动 diff。
pub(super) fn init_git_workspace() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut dir = std::env::temp_dir();
    dir.push(format!("ws_git_it_{}_{}", std::process::id(), seq));
    fs::create_dir_all(&dir).expect("create temp root");
    let root = fs::canonicalize(&dir).expect("canonicalize temp root");

    fs::write(root.join("a.txt"), "ALPHA_MARKER\n").expect("seed a.txt");
    fs::write(root.join("b.txt"), "BETA_MARKER\n").expect("seed b.txt");
    run_setup_git(&root, &["init", "-q"]);
    // 显式设本地身份，避免依赖全局 git config（CI/干净机器上可能没配）。
    run_setup_git(&root, &["config", "user.email", "test@example.com"]);
    run_setup_git(&root, &["config", "user.name", "Test"]);
    run_setup_git(&root, &["add", "-A"]);
    // 关签名，避免全局 commit.gpgsign=true 但无密钥时提交失败。
    run_setup_git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    );
    root
}

// 真跑一条 git 命令（测试搭台用，非被测代码）；失败即 panic 便于定位。
pub(super) fn run_setup_git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("spawn git for test setup");
    assert!(
        output.status.success(),
        "git {:?} 失败: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

pub(super) fn root_arg(root: &Path) -> Option<String> {
    Some(root.to_string_lossy().into_owned())
}
