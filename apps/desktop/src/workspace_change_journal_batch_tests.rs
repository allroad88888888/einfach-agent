use super::*;
use crate::workspace_change_journal::prepare::{mark_change_applied, prepare_change_set};
use crate::workspace_change_journal::test_support::{context, roots};
use crate::workspace_change_journal::types::ChangeFileInput;

#[test]
fn batch_reverts_multiple_change_sets_and_files_in_reverse_order() {
    let (workspace, journal) = roots();
    fs::write(workspace.join("a.txt"), "a-3").expect("seed latest a");
    fs::write(workspace.join("b.txt"), "b-2").expect("seed latest b");

    prepare_change_set(
        &journal,
        context("batch-1"),
        &workspace,
        vec![
            ChangeFileInput {
                path: "a.txt".to_string(),
                before: Some("a-1".to_string()),
                after: Some("a-2".to_string()),
            },
            ChangeFileInput {
                path: "b.txt".to_string(),
                before: Some("b-1".to_string()),
                after: Some("b-2".to_string()),
            },
        ],
    )
    .expect("prepare first");
    mark_change_applied(&journal, "batch-1").expect("mark first");
    prepare_change_set(
        &journal,
        context("batch-2"),
        &workspace,
        vec![ChangeFileInput {
            path: "a.txt".to_string(),
            before: Some("a-2".to_string()),
            after: Some("a-3".to_string()),
        }],
    )
    .expect("prepare second");
    mark_change_applied(&journal, "batch-2").expect("mark second");

    let ids = vec!["batch-1".to_string(), "batch-2".to_string()];
    let result =
        revert_change_sets_blocking(&journal, &ids, false, &workspace).expect("batch revert");

    assert!(result.ok);
    assert_eq!(result.status, "batch_reverted");
    assert_eq!(result.reverted_change_set_ids, vec!["batch-2", "batch-1"]);
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a-1");
    assert_eq!(fs::read_to_string(workspace.join("b.txt")).unwrap(), "b-1");
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}

#[test]
fn batch_conflict_preflight_leaves_every_file_untouched() {
    let (workspace, journal) = roots();
    fs::write(workspace.join("a.txt"), "a-2").expect("seed a");
    fs::write(workspace.join("b.txt"), "user-edit").expect("seed b");

    for (id, path, before, after) in [
        ("batch-safe", "a.txt", "a-1", "a-2"),
        ("batch-conflict", "b.txt", "b-1", "b-2"),
    ] {
        prepare_change_set(
            &journal,
            context(id),
            &workspace,
            vec![ChangeFileInput {
                path: path.to_string(),
                before: Some(before.to_string()),
                after: Some(after.to_string()),
            }],
        )
        .expect("prepare");
        mark_change_applied(&journal, id).expect("mark");
    }

    let ids = vec!["batch-safe".to_string(), "batch-conflict".to_string()];
    let result =
        revert_change_sets_blocking(&journal, &ids, false, &workspace).expect("batch check");

    assert!(!result.ok);
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "a-2");
    assert_eq!(
        fs::read_to_string(workspace.join("b.txt")).unwrap(),
        "user-edit"
    );
    let _ = fs::remove_dir_all(workspace.parent().expect("base"));
}
