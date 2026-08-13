use super::*;
use crate::workspace_read::test_support::{root_arg, unique_workspace};

// ★ 跨语言契约测试 ★ —— 项目 skills 的扫描器（packages/agent-core/src/skills/
// projectSkillsLoader.ts）靠 `path.split('/').length === 4` 判定「.webAgent/skills 的直接
// 子目录」，又靠 list 失败的错误文本把「目录不存在」判成常态而非异常。两者都依赖本文件
// 的可观察行为，且一旦漂移是【静默】失效：路径多个 './' 前缀，项目 skills 会全部消失而
// 不报任何错。这两个断言把该契约钉死在 Rust 侧。
#[test]
fn list_returns_workspace_relative_slash_paths_for_nested_skill_dirs() {
    let (base, ws) = unique_workspace();
    fs::create_dir_all(ws.join(".webAgent/skills/demo/references")).expect("create skill dirs");
    fs::write(
        ws.join(".webAgent/skills/demo/SKILL.md"),
        "---\nname: demo\n---\n",
    )
    .expect("seed skill");
    fs::write(
        ws.join(".webAgent/skills/demo/references/checklist.md"),
        "x",
    )
    .expect("seed resource");

    let result = list_workspace_files_blocking(
        Some(".webAgent/skills".to_string()),
        Some(true),
        Some(2000),
        Some(true), // .webAgent 是隐藏目录，不开 include_hidden 一个条目都列不到
        root_arg(&ws),
    )
    .expect("list should succeed");

    let paths: Vec<&str> = result.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(
        paths.contains(&".webAgent/skills/demo/SKILL.md"),
        "路径须为 workspace 相对 + 正斜杠、无 './' 前缀，实得 {paths:?}"
    );
    assert_eq!(
        ".webAgent/skills/demo/SKILL.md".split('/').count(),
        4,
        "loader 用四段判定直接子目录"
    );
    assert!(paths.contains(&".webAgent/skills/demo/references/checklist.md"));

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn list_missing_directory_errors_with_not_accessible_text() {
    let (base, ws) = unique_workspace();

    let outcome = list_workspace_files_blocking(
        Some(".webAgent/skills".to_string()),
        Some(true),
        Some(2000),
        Some(true),
        root_arg(&ws),
    );
    let err = match outcome {
        Ok(_) => {
            panic!("缺失目录必须报错，否则 loader 无从区分「没有项目 skills」与「扫描出问题」")
        }
        Err(err) => err,
    };
    let lowered = err.to_lowercase();
    assert!(
        lowered.contains("is not accessible") || lowered.contains("no such file"),
        "loader 的 isMissingDirectoryError 依赖这段文本，实得: {err}"
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn list_files_includes_nested_entry() {
    // list_files 递归列出真实存在的嵌套文件。
    let (base, ws) = unique_workspace();
    fs::create_dir_all(ws.join("src")).expect("mkdir src");
    fs::write(ws.join("src/app.ts"), "export const x = 1;\n").expect("seed nested file");

    let result =
        list_workspace_files_blocking(Some(".".to_string()), Some(true), None, None, root_arg(&ws))
            .expect("list should succeed");
    assert!(
        result
            .entries
            .iter()
            .any(|e| e.path == "src/app.ts" && e.entry_type == "file"),
        "应列出 src/app.ts(file)，实际: {:?}",
        result.entries.iter().map(|e| &e.path).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&base);
}
