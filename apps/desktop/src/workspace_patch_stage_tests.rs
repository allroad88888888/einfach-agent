use super::*;
use crate::workspace_patch::test_support::{add, delete, unique_root};
use std::fs;

// P2：只用标准库搭临时 workspace（不引 tempfile 依赖），聚焦验证 add_file 的
// delete+add 绕过守卫已被堵死，且合法的 add→delete→add 回归仍放行。

#[test]
fn delete_then_add_existing_file_is_rejected() {
    let root = unique_root();
    fs::write(root.join("existing.txt"), "on disk").expect("seed existing file");
    let mut files: HashMap<PathBuf, FileState> = HashMap::new();

    // 先删已存在文件（current -> None），再对同路径 add：initial 仍为 Some，必须被拒。
    stage_operation(&root, &mut files, &delete("existing.txt")).expect("delete should stage");
    let err = stage_operation(&root, &mut files, &add("existing.txt", "replaced"))
        .expect_err("add over a file that existed on disk must be rejected");
    assert!(
        err.contains("use overwrite_file"),
        "unexpected error message: {err}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn add_delete_add_fresh_path_is_allowed() {
    let root = unique_root();
    let mut files: HashMap<PathBuf, FileState> = HashMap::new();

    // 本批内全程新建：initial 始终为 None，add→delete→add 同路径应放行。
    stage_operation(&root, &mut files, &add("fresh.txt", "first")).expect("first add");
    stage_operation(&root, &mut files, &delete("fresh.txt")).expect("delete staged add");
    stage_operation(&root, &mut files, &add("fresh.txt", "second")).expect("re-add is allowed");

    let state = files
        .get(&root.join("fresh.txt"))
        .expect("fresh.txt should be staged");
    assert_eq!(state.current.as_deref(), Some("second"));

    let _ = fs::remove_dir_all(&root);
}
