use super::*;
use crate::workspace_patch::test_support::{
    add, delete, overwrite, replace, root_arg, unique_root,
};
use std::fs;

#[test]
fn result_reports_per_file_change_summaries() {
    // 和 write_file 同形的回执：模型不必为了确认改动而把每个文件再读一遍。
    let root = unique_root();
    fs::write(root.join("edit.txt"), "keep\nold\n").expect("seed");
    fs::write(root.join("gone.txt"), "bye\n").expect("seed");

    let result = apply_workspace_patch_blocking(
        vec![
            add("fresh.txt", "one\ntwo\n"),
            overwrite("edit.txt", "keep\nnew\n", Some("keep\nold\n"), None),
            delete("gone.txt"),
        ],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(result.ok, "被拒: {:?}", result.rejected);
    let by_path = |name: &str| {
        result
            .changes
            .iter()
            .find(|change| change.path == name)
            .unwrap_or_else(|| panic!("missing change for {name}"))
    };

    let fresh = by_path("fresh.txt");
    assert!(fresh.created);
    assert_eq!(fresh.change_summary.as_ref().expect("summary").lines_added, 2);

    let edited = by_path("edit.txt");
    assert!(!edited.created && !edited.deleted);
    let summary = edited.change_summary.as_ref().expect("summary");
    assert_eq!(summary.lines_added, 1);
    assert_eq!(summary.lines_removed, 1);

    let removed = by_path("gone.txt");
    assert!(removed.deleted);
    assert!(removed.change_summary.is_none(), "删除没有 after 可 diff");
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn executable_bit_applies_within_the_transaction() {
    use std::os::unix::fs::PermissionsExt;
    let root = unique_root();

    let result = apply_workspace_patch_blocking(
        vec![PatchOperation::AddFile {
            path: "run.sh".to_string(),
            content: "#!/bin/sh\n".to_string(),
            executable: Some(true),
        }],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(result.ok, "被拒: {:?}", result.rejected);
    let mode = fs::metadata(root.join("run.sh"))
        .expect("stat")
        .permissions()
        .mode();
    assert_eq!(mode & 0o100, 0o100, "脚手架脚本应可直接执行");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn dry_run_reports_summaries_without_writing() {
    let root = unique_root();
    fs::write(root.join("edit.txt"), "old\n").expect("seed");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("edit.txt", "new\n", Some("old\n"), None)],
        true,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(result.ok && result.dry_run && result.would_change);
    assert_eq!(
        result.changes[0]
            .change_summary
            .as_ref()
            .expect("summary")
            .lines_added,
        1
    );
    assert_eq!(
        fs::read_to_string(root.join("edit.txt")).expect("read back"),
        "old\n",
        "dry run 不能改动磁盘"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn replace_edits_file_on_disk() {
    // 真在磁盘上跑 replace（非 dry_run）：apply 后磁盘内容真被改，changed_files 合理。
    let root = unique_root();
    fs::write(root.join("code.txt"), "const answer = 41;\n").expect("seed file");

    let result = apply_workspace_patch_blocking(
        vec![replace("code.txt", "41", "42")],
        false,
        root_arg(&root),
    )
    .expect("patch worker should not error");
    assert!(result.ok, "replace 应成功，rejected: {:?}", result.rejected);
    assert_eq!(result.changed_files, vec!["code.txt".to_string()]);

    let on_disk = fs::read_to_string(root.join("code.txt")).expect("read back");
    assert_eq!(on_disk, "const answer = 42;\n", "磁盘内容应被真替换");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn dry_run_does_not_touch_disk() {
    // dry_run：would_change 为真但磁盘不变。
    let root = unique_root();
    fs::write(root.join("code.txt"), "value = 1\n").expect("seed file");

    let result =
        apply_workspace_patch_blocking(vec![replace("code.txt", "1", "2")], true, root_arg(&root))
            .expect("patch worker should not error");
    assert!(result.ok);
    assert!(result.would_change, "dry_run 应报告 would_change");

    let on_disk = fs::read_to_string(root.join("code.txt")).expect("read back");
    assert_eq!(on_disk, "value = 1\n", "dry_run 不应改磁盘");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn replace_outside_workspace_is_rejected() {
    // confine：replace 一个 ../ 越界路径 → 被拒(rejected 非空、ok=false)。
    let root = unique_root();
    let result = apply_workspace_patch_blocking(
        vec![replace("../evil.txt", "a", "b")],
        false,
        root_arg(&root),
    )
    .expect("patch worker should not error");
    assert!(!result.ok, "越界 replace 必须失败");
    assert!(!result.rejected.is_empty(), "应有 rejected 记录");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn successful_patch_returns_persisted_change_set() {
    let root = unique_root();
    let journal = root.join(".journal");
    fs::write(root.join("code.txt"), "before").expect("seed file");
    let result = apply_workspace_patch_blocking_with_journal(
        vec![replace("code.txt", "before", "after")],
        false,
        root_arg(&root),
        Some((
            journal.clone(),
            WorkspaceChangeContext {
                change_id: "patch-change".to_string(),
                session_id: "session".to_string(),
                run_id: "run".to_string(),
                tool_call_id: "call".to_string(),
            },
        )),
        "patch-change".to_string(),
    )
    .expect("apply journaled patch");

    assert_eq!(
        result.change_set.as_ref().map(|change| change.id.as_str()),
        Some("patch-change")
    );
    assert!(journal.join("patch-change.json").is_file());
    let _ = fs::remove_dir_all(&root);
}
