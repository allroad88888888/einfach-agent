use super::*;
use crate::workspace_read::test_support::{root_arg, unique_workspace};

#[test]
fn search_files_finds_keyword() {
    // search_files 在真实文件里搜到关键字，返回相对路径 + 行号 + 命中行。
    let (base, ws) = unique_workspace();
    fs::create_dir_all(ws.join("src")).expect("mkdir src");
    fs::write(
        ws.join("src/app.ts"),
        "line one\nfind NEEDLE_TOKEN here\nline three\n",
    )
    .expect("seed file");

    let result = search_workspace_files_blocking(
        "NEEDLE_TOKEN".to_string(),
        None,
        None,
        None,
        root_arg(&ws),
    )
    .expect("search should succeed");
    assert_eq!(result.matches.len(), 1, "应命中 1 处");
    let m = &result.matches[0];
    assert_eq!(m.path, "src/app.ts");
    assert_eq!(m.line_number, 2, "命中在第 2 行");
    assert!(m.line.contains("NEEDLE_TOKEN"));

    let _ = fs::remove_dir_all(&base);
}
