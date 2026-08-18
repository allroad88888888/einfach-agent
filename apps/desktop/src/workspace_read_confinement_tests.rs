use super::*;
use crate::workspace_common::resolve_workspace_root;
use crate::workspace_read::bytes::{
    read_workspace_file_blocking, read_workspace_file_blocking_with_access,
};
use crate::workspace_read::list::list_workspace_files_blocking_with_access;
use crate::workspace_read::search::search_workspace_files_blocking_with_access;
use crate::workspace_read::test_support::{root_arg, unique_workspace};

#[test]
fn read_rejects_parent_escape() {
    // 真实越界：在 workspace 外(base)放 secret.txt，用 ../secret.txt 读 → 被 confine 拒。
    let (base, ws) = unique_workspace();
    fs::write(base.join("secret.txt"), "top secret").expect("seed outside file");

    // ReadWorkspaceFileResult 无 Debug，避免 expect_err，直接 match 取 Err。
    let err = match read_workspace_file_blocking("../secret.txt".to_string(), None, root_arg(&ws)) {
        Err(err) => err,
        Ok(_) => panic!("workspace 外文件必须被拒"),
    };
    assert!(
        err.contains("escapes workspace root") || err.contains("not accessible"),
        "应因越界被拒，实际: {err}"
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn read_rejects_absolute_outside_path() {
    // workspace 外的绝对路径 → canonicalize 后 starts_with(root) 失败被拒。
    let (base, ws) = unique_workspace();
    let outside = base.join("secret.txt");
    fs::write(&outside, "top secret").expect("seed outside file");

    let err = match read_workspace_file_blocking(
        outside.to_string_lossy().into_owned(),
        None,
        root_arg(&ws),
    ) {
        Err(err) => err,
        Ok(_) => panic!("workspace 外绝对路径必须被拒"),
    };
    assert!(
        err.contains("escapes workspace root"),
        "应因越界被拒，实际: {err}"
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn auto_read_allows_parent_and_absolute_outside_paths() {
    let (base, ws) = unique_workspace();
    let outside = base.join("secret.txt");
    fs::write(&outside, "auto readable").expect("seed outside file");
    let outside = fs::canonicalize(&outside).expect("canonicalize outside");
    let expected_path = display_path(&outside);

    let via_parent = read_workspace_file_blocking_with_access(
        "../secret.txt".to_string(),
        None,
        root_arg(&ws),
        true,
    )
    .expect("Auto should allow parent path");
    assert_eq!(via_parent.content, "auto readable");
    assert_eq!(via_parent.path, expected_path);

    let via_absolute = read_workspace_file_blocking_with_access(
        outside.to_string_lossy().into_owned(),
        None,
        root_arg(&ws),
        true,
    )
    .expect("Auto should allow absolute outside path");
    assert_eq!(via_absolute.content, "auto readable");
    assert_eq!(via_absolute.path, expected_path);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn auto_list_and_search_allow_external_directory() {
    let (base, ws) = unique_workspace();
    let outside_dir = base.join("outside");
    fs::create_dir_all(&outside_dir).expect("create outside dir");
    let outside_file = outside_dir.join("notes.txt");
    fs::write(&outside_file, "line one\nAUTO_OUTSIDE_NEEDLE\n").expect("seed outside file");
    let outside_dir = fs::canonicalize(&outside_dir).expect("canonicalize outside dir");
    let outside_file = fs::canonicalize(&outside_file).expect("canonicalize outside file");
    let expected_path = display_path(&outside_file);

    let listed = list_workspace_files_blocking_with_access(
        Some(outside_dir.to_string_lossy().into_owned()),
        Some(false),
        None,
        None,
        root_arg(&ws),
        true,
    )
    .expect("Auto should list outside dir");
    assert!(
        listed
            .entries
            .iter()
            .any(|entry| entry.path == expected_path && entry.entry_type == "file"),
        "external list should return absolute path"
    );

    let searched = search_workspace_files_blocking_with_access(
        "AUTO_OUTSIDE_NEEDLE".to_string(),
        Some("../outside".to_string()),
        None,
        None,
        root_arg(&ws),
        true,
    )
    .expect("Auto should search outside dir");
    assert_eq!(searched.matches.len(), 1);
    assert_eq!(searched.matches[0].path, expected_path);
    assert_eq!(searched.matches[0].line_number, 2);

    let _ = fs::remove_dir_all(&base);
}

#[cfg(unix)]
#[test]
fn auto_read_follows_symlink_to_external_file_while_confirm_rejects_it() {
    use std::os::unix::fs::symlink;

    let (base, ws) = unique_workspace();
    let outside = base.join("secret.txt");
    fs::write(&outside, "linked outside").expect("seed outside file");
    symlink(&outside, ws.join("linked-secret.txt")).expect("create symlink");

    let strict_error =
        match read_workspace_file_blocking("linked-secret.txt".to_string(), None, root_arg(&ws)) {
            Err(err) => err,
            Ok(_) => panic!("Confirm must reject a symlink escaping workspace"),
        };
    assert!(strict_error.contains("escapes workspace root"));

    let result = read_workspace_file_blocking_with_access(
        "linked-secret.txt".to_string(),
        None,
        root_arg(&ws),
        true,
    )
    .expect("Auto should follow external symlink");
    assert_eq!(result.content, "linked outside");
    assert_eq!(
        result.path,
        display_path(&fs::canonicalize(&outside).expect("canonicalize outside"))
    );

    let _ = fs::remove_dir_all(&base);
}

/// 跨语言契约：symlink 指向根外的 skill 目录，在 confine 列表里**整条不出现**，
/// 而带 allow_external_paths 时以 `symlink` 类型出现、路径仍是根相对。
///
/// 项目/用户 skills 的 loader 依赖这两条：符号链接进 `.claude/skills` 是 dotfiles 的常见写法，
/// 若列表里连它都看不见，那批 skill 就是**静默缺席**——用户只会看到「我明明放了」。
/// 顺带钉住 `collect_entries` 不递归进 symlink（因此 loader 必须把它当独立根再扫一次）。
#[cfg(unix)]
#[test]
fn linked_skill_dir_is_invisible_under_confinement_but_listed_with_external_access() {
    use std::os::unix::fs::symlink;

    let (base, ws) = unique_workspace();
    let outside_skill = base.join("outside-skill");
    fs::create_dir_all(&outside_skill).expect("create outside skill dir");
    fs::write(outside_skill.join("SKILL.md"), "---\nname: x\n---\n").expect("seed SKILL.md");
    let skills_dir = ws.join(".claude").join("skills");
    fs::create_dir_all(&skills_dir).expect("create skills dir");
    symlink(&outside_skill, skills_dir.join("linked")).expect("create symlink");

    let confined = list_workspace_files_blocking_with_access(
        Some(".claude/skills".to_string()),
        Some(true),
        None,
        Some(true),
        root_arg(&ws),
        false,
    )
    .expect("confined list should succeed");
    let confined_paths: Vec<&str> = confined
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    assert!(
        confined_paths.is_empty(),
        "根外 symlink 在 confine 列表里必须整条不出现，实际: {confined_paths:?}"
    );

    let external = list_workspace_files_blocking_with_access(
        Some(".claude/skills".to_string()),
        Some(true),
        None,
        Some(true),
        root_arg(&ws),
        true,
    )
    .expect("external list should succeed");
    assert_eq!(external.entries.len(), 1, "不递归进 symlink：只出现它本身");
    assert_eq!(external.entries[0].path, ".claude/skills/linked");
    assert_eq!(external.entries[0].entry_type, "symlink");

    let _ = fs::remove_dir_all(&base);
}

/// 跨语言契约：把 symlink 自身当 workspace_root 传入时，它被 canonicalize 成目标目录，
/// 目录内文件以**根相对**路径返回，且无需 allow_external_paths。
/// loader 正是靠这条把每个被链接的 skill 目录当成它自己的根来读。
#[cfg(unix)]
#[test]
fn linked_skill_dir_can_be_listed_as_its_own_root() {
    use std::os::unix::fs::symlink;

    let (base, ws) = unique_workspace();
    let outside_skill = base.join("outside-skill");
    fs::create_dir_all(outside_skill.join("references")).expect("create outside skill dir");
    fs::write(outside_skill.join("SKILL.md"), "---\nname: x\n---\n").expect("seed SKILL.md");
    fs::write(outside_skill.join("references").join("a.md"), "note").expect("seed resource");
    let skills_dir = ws.join(".claude").join("skills");
    fs::create_dir_all(&skills_dir).expect("create skills dir");
    let link = skills_dir.join("linked");
    symlink(&outside_skill, &link).expect("create symlink");

    let listed = list_workspace_files_blocking_with_access(
        None,
        Some(true),
        None,
        Some(true),
        root_arg(&link),
        false,
    )
    .expect("symlink itself should resolve to a usable root");
    let paths: Vec<&str> = listed
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    assert!(paths.contains(&"SKILL.md"), "实际: {paths:?}");
    assert!(paths.contains(&"references/a.md"), "实际: {paths:?}");

    let read = read_workspace_file_blocking("SKILL.md".to_string(), None, root_arg(&link))
        .expect("SKILL.md should be readable inside its own root");
    assert_eq!(read.content, "---\nname: x\n---\n");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn resolve_workspace_root_rejects_filesystem_root() {
    // resolve_workspace_root(Some("/")) → 拒（文件系统根，否则整块磁盘都成 workspace，confine 形同虚设）。
    let err = resolve_workspace_root(Some("/")).expect_err("文件系统根必须被拒");
    assert!(
        err.contains("filesystem root"),
        "应因文件系统根被拒，实际: {err}"
    );
}
