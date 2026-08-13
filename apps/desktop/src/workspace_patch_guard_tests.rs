use super::*;
use crate::workspace_patch::pipeline::apply_workspace_patch_blocking;
use crate::workspace_patch::test_support::{overwrite, unique_root};
use std::fs;

#[test]
fn overwrite_accepts_a_content_hash_instead_of_the_whole_previous_file() {
    // 以前只能靠 oldContent 全文比对，等于每次覆盖都要把整个旧文件塞进参数里。
    let root = unique_root();
    fs::write(root.join("code.txt"), "old\n").expect("seed");
    let hash = content_sha256(b"old\n");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("code.txt", "new\n", None, Some(&hash))],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(result.ok, "被拒: {:?}", result.rejected);
    assert_eq!(
        fs::read_to_string(root.join("code.txt")).expect("read back"),
        "new\n"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn overwrite_rejects_a_stale_content_hash() {
    let root = unique_root();
    fs::write(root.join("code.txt"), "current\n").expect("seed");
    let stale = content_sha256(b"outdated\n");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("code.txt", "new\n", None, Some(&stale))],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(!result.ok);
    assert!(result.rejected[0].reason.contains("expectedContentHash"));
    assert_eq!(
        fs::read_to_string(root.join("code.txt")).expect("read back"),
        "current\n",
        "被拒的事务不能落盘"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn overwrite_still_demands_proof_the_file_was_read() {
    let root = unique_root();
    fs::write(root.join("code.txt"), "old\n").expect("seed");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("code.txt", "new\n", None, None)],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(!result.ok);
    assert!(result.rejected[0]
        .reason
        .contains("oldContent or expectedContentHash is required"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn guards_cannot_be_supplied_twice_over() {
    let root = unique_root();
    fs::write(root.join("code.txt"), "old\n").expect("seed");
    let hash = content_sha256(b"old\n");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("code.txt", "new\n", Some("old\n"), Some(&hash))],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(!result.ok);
    assert!(result.rejected[0].reason.contains("not both"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn malformed_content_hash_is_rejected() {
    let root = unique_root();
    fs::write(root.join("code.txt"), "old\n").expect("seed");

    let result = apply_workspace_patch_blocking(
        vec![overwrite("code.txt", "new\n", None, Some("sha256:nope"))],
        false,
        Some(root.to_string_lossy().into_owned()),
    )
    .expect("patch");

    assert!(!result.ok);
    assert!(result.rejected[0]
        .reason
        .contains("64 lowercase hex characters"));
    let _ = fs::remove_dir_all(&root);
}
