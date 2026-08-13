use super::*;
use crate::workspace_git::test_support::{init_git_workspace, root_arg, run_setup_git};
use std::fs;

#[test]
fn diff_reports_working_tree_change() {
    // 改动已提交文件 → get_workspace_diff 的 diff 含改动、status/changed_files 合理。
    let root = init_git_workspace();
    fs::write(root.join("a.txt"), "ALPHA_MODIFIED\n").expect("modify a.txt");

    let result = get_workspace_diff_blocking(None, None, None, None, None, root_arg(&root))
        .expect("diff worker should not error");
    assert_eq!(result.exit_code, 0, "git 应成功，stderr: {}", result.stderr);
    assert!(
        result.diff.contains("ALPHA_MODIFIED"),
        "diff 应含改动内容: {}",
        result.diff
    );
    assert!(
        result.changed_files.contains(&"a.txt".to_string()),
        "changed_files 应含 a.txt: {:?}",
        result.changed_files
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn diff_scoped_to_pathspec_excludes_unrelated_files() {
    // P2 scoped：同时改 a.txt / b.txt，但只请求 a.txt → diff / changed_files 都不含 b.txt。
    let root = init_git_workspace();
    fs::write(root.join("a.txt"), "ALPHA_MODIFIED\n").expect("modify a.txt");
    fs::write(root.join("b.txt"), "BETA_MODIFIED\n").expect("modify b.txt");

    let result = get_workspace_diff_blocking(
        Some(vec!["a.txt".to_string()]),
        None,
        None,
        None,
        None,
        root_arg(&root),
    )
    .expect("diff worker should not error");
    assert_eq!(result.exit_code, 0, "git 应成功，stderr: {}", result.stderr);
    assert!(
        result.diff.contains("ALPHA_MODIFIED"),
        "diff 应含被请求文件的改动: {}",
        result.diff
    );
    assert!(
        !result.diff.contains("BETA_MODIFIED"),
        "scoped diff 不应含未请求的 b.txt 改动: {}",
        result.diff
    );
    assert_eq!(
        result.changed_files,
        vec!["a.txt".to_string()],
        "scoped status 只应含 a.txt，实际: {:?}",
        result.changed_files
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn diff_can_compare_against_a_base_commit() {
    let root = init_git_workspace();
    fs::write(root.join("a.txt"), "ALPHA_IN_SECOND_COMMIT\n").expect("modify a.txt");
    run_setup_git(&root, &["add", "a.txt"]);
    run_setup_git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "second"],
    );

    let result = get_workspace_diff_blocking(
        None,
        None,
        Some("HEAD~1".to_string()),
        None,
        None,
        root_arg(&root),
    )
    .expect("base diff worker should not error");

    assert_eq!(result.exit_code, 0, "git 应成功，stderr: {}", result.stderr);
    assert_eq!(result.base.as_deref(), Some("HEAD~1"));
    assert!(result.diff.contains("ALPHA_IN_SECOND_COMMIT"));
    assert_eq!(result.changed_files, vec!["a.txt".to_string()]);

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn diff_rejects_option_like_or_unknown_base() {
    let root = init_git_workspace();
    for base in ["--output=/tmp/x", "missing-ref"] {
        let result = get_workspace_diff_blocking(
            None,
            None,
            Some(base.to_string()),
            None,
            None,
            root_arg(&root),
        )
        .expect("invalid base should be a structured failure");
        assert_eq!(result.exit_code, 1);
        assert!(result.stderr.contains("base"));
    }

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn diff_rejects_path_escaping_workspace() {
    // confine：请求 ../ 越界 pathspec → 结构化失败(exit_code=1，stderr 说明越界)。
    let root = init_git_workspace();
    let result = get_workspace_diff_blocking(
        Some(vec!["../outside.txt".to_string()]),
        None,
        None,
        None,
        None,
        root_arg(&root),
    )
    .expect("diff worker should not error");
    assert_eq!(result.exit_code, 1, "越界 pathspec 应失败");
    assert!(
        result.stderr.contains("stay inside") || result.stderr.contains("escapes"),
        "stderr 应说明越界，实际: {}",
        result.stderr
    );

    let _ = fs::remove_dir_all(&root);
}
