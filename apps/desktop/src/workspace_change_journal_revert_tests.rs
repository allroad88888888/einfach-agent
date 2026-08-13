use super::*;
use crate::workspace_change_journal::prepare::{mark_change_applied, prepare_change_set};
use crate::workspace_change_journal::test_support::{context, roots};
use crate::workspace_change_journal::types::ChangeFileInput;

#[test]
fn reverts_create_and_is_idempotent() {
    let (workspace, journal) = roots();
    fs::write(workspace.join("new.txt"), "new").expect("seed after");
    prepare_change_set(
        &journal,
        context("create-1"),
        &workspace,
        vec![ChangeFileInput {
            path: "new.txt".to_string(),
            before: None,
            after: Some("new".to_string()),
        }],
    )
    .expect("prepare");
    mark_change_applied(&journal, "create-1").expect("mark");

    let result =
        revert_change_set_blocking(&journal, "create-1", false, &workspace).expect("revert");
    assert!(result.ok);
    assert!(!workspace.join("new.txt").exists());
    let repeated =
        revert_change_set_blocking(&journal, "create-1", false, &workspace).expect("repeat");
    assert_eq!(repeated.status, "already_reverted");
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}

#[test]
fn refuses_drift_without_partial_revert() {
    let (workspace, journal) = roots();
    fs::write(workspace.join("a.txt"), "after-a").expect("seed a");
    fs::write(workspace.join("b.txt"), "user-edit").expect("seed b");
    prepare_change_set(
        &journal,
        context("conflict-1"),
        &workspace,
        vec![
            ChangeFileInput {
                path: "a.txt".to_string(),
                before: Some("before-a".to_string()),
                after: Some("after-a".to_string()),
            },
            ChangeFileInput {
                path: "b.txt".to_string(),
                before: Some("before-b".to_string()),
                after: Some("after-b".to_string()),
            },
        ],
    )
    .expect("prepare");
    mark_change_applied(&journal, "conflict-1").expect("mark");

    let result =
        revert_change_set_blocking(&journal, "conflict-1", false, &workspace).expect("revert");
    assert!(!result.ok);
    assert_eq!(result.status, "conflict");
    assert_eq!(
        fs::read_to_string(workspace.join("a.txt")).unwrap(),
        "after-a"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("b.txt")).unwrap(),
        "user-edit"
    );
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}

#[test]
fn reverts_multiple_files_in_one_change_set() {
    let (workspace, journal) = roots();
    fs::write(workspace.join("edited.txt"), "after-edit").expect("seed edited file");
    fs::write(workspace.join("created.txt"), "created").expect("seed created file");
    prepare_change_set(
        &journal,
        context("multi-file"),
        &workspace,
        vec![
            ChangeFileInput {
                path: "edited.txt".to_string(),
                before: Some("before-edit".to_string()),
                after: Some("after-edit".to_string()),
            },
            ChangeFileInput {
                path: "created.txt".to_string(),
                before: None,
                after: Some("created".to_string()),
            },
            ChangeFileInput {
                path: "deleted.txt".to_string(),
                before: Some("before-delete".to_string()),
                after: None,
            },
        ],
    )
    .expect("prepare");
    mark_change_applied(&journal, "multi-file").expect("mark");

    let result =
        revert_change_set_blocking(&journal, "multi-file", false, &workspace).expect("revert");

    assert!(result.ok);
    assert_eq!(
        result.restored_files,
        vec!["edited.txt", "created.txt", "deleted.txt"]
    );
    assert_eq!(
        fs::read_to_string(workspace.join("edited.txt")).unwrap(),
        "before-edit"
    );
    assert!(!workspace.join("created.txt").exists());
    assert_eq!(
        fs::read_to_string(workspace.join("deleted.txt")).unwrap(),
        "before-delete"
    );
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}

#[test]
fn sequential_changes_revert_newest_first_then_older() {
    let (workspace, journal) = roots();
    let path = workspace.join("value.txt");
    fs::write(&path, "version-3").expect("seed latest version");

    prepare_change_set(
        &journal,
        context("change-1"),
        &workspace,
        vec![ChangeFileInput {
            path: "value.txt".to_string(),
            before: Some("version-1".to_string()),
            after: Some("version-2".to_string()),
        }],
    )
    .expect("prepare first");
    mark_change_applied(&journal, "change-1").expect("mark first");
    prepare_change_set(
        &journal,
        context("change-2"),
        &workspace,
        vec![ChangeFileInput {
            path: "value.txt".to_string(),
            before: Some("version-2".to_string()),
            after: Some("version-3".to_string()),
        }],
    )
    .expect("prepare second");
    mark_change_applied(&journal, "change-2").expect("mark second");

    let out_of_order =
        revert_change_set_blocking(&journal, "change-1", false, &workspace).expect("check old");
    assert!(!out_of_order.ok);
    assert_eq!(out_of_order.status, "conflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "version-3");

    let newest =
        revert_change_set_blocking(&journal, "change-2", false, &workspace).expect("revert new");
    assert!(newest.ok);
    assert_eq!(fs::read_to_string(&path).unwrap(), "version-2");

    let older =
        revert_change_set_blocking(&journal, "change-1", false, &workspace).expect("revert old");
    assert!(older.ok);
    assert_eq!(fs::read_to_string(&path).unwrap(), "version-1");
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}
