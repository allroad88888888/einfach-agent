// 真写磁盘的集成测试：create 模式真在磁盘落文件（含 create_dirs 建父目录），
// upsert/overwrite 的模式语义、dry run、可逆性与 change set 都以磁盘实际结果为准。
use super::*;
use crate::workspace_write::test_support::{root_arg, unique_workspace};

#[test]
fn create_writes_file_to_disk() {
    // create 模式：磁盘上真出现文件且内容正确，path 为 workspace 相对，created=true。
    let (base, ws) = unique_workspace();
    let result = write_workspace_file_blocking(
        "out/hello.txt".to_string(),
        "written content".to_string(),
        Some("create".to_string()),
        None,
        Some(true), // create_dirs：out/ 不存在，需自动建
        None,
        None,
        root_arg(&ws),
    )
    .expect("worker 层不应报错");
    assert!(result.ok, "create 应成功，错误: {:?}", result.error);
    assert!(result.created, "应标记为新建");
    assert_eq!(result.path, "out/hello.txt", "path 应为 workspace 相对路径");

    let on_disk = fs::read_to_string(ws.join("out/hello.txt")).expect("文件应真出现在磁盘");
    assert_eq!(on_disk, "written content", "磁盘内容应与写入一致");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn upsert_creates_when_absent_and_overwrites_when_present() {
    let (base, ws) = unique_workspace();

    let created = write_workspace_file_blocking(
        "notes/entry.txt".to_string(),
        "first".to_string(),
        Some("upsert".to_string()),
        None,
        None, // create_dirs 默认应为 true
        None,
        None,
        root_arg(&ws),
    )
    .expect("upsert create");
    assert!(created.ok, "upsert 应能新建，错误: {:?}", created.error);
    assert!(created.created, "缺失文件时 upsert 记为新建");
    assert!(!created.overwritten);

    let replaced = write_workspace_file_blocking(
        "notes/entry.txt".to_string(),
        "second".to_string(),
        Some("upsert".to_string()),
        None,
        None,
        None,
        None,
        root_arg(&ws),
    )
    .expect("upsert overwrite");
    assert!(replaced.ok, "错误: {:?}", replaced.error);
    assert!(!replaced.created, "已存在文件时 upsert 记为覆盖");
    assert!(replaced.overwritten);
    assert_eq!(
        fs::read_to_string(ws.join("notes/entry.txt")).expect("read back"),
        "second"
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn overwrite_on_missing_file_points_at_upsert() {
    let (base, ws) = unique_workspace();
    let result = write_workspace_file_blocking(
        "absent.txt".to_string(),
        "x".to_string(),
        Some("overwrite".to_string()),
        None,
        None,
        None,
        None,
        root_arg(&ws),
    )
    .expect("structured rejection");

    assert!(!result.ok);
    assert!(
        result.error.as_deref().unwrap_or_default().contains("upsert"),
        "错误应指向 upsert，实际: {:?}",
        result.error
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn dry_run_reports_the_change_without_writing() {
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.txt"), "keep\nold\n").expect("seed");

    let result = write_workspace_file_blocking_with_options(
        "code.txt".to_string(),
        "keep\nnew\n".to_string(),
        Some("overwrite".to_string()),
        root_arg(&ws),
        None,
        None,
        Some(true),
    )
    .expect("dry run");

    assert!(result.ok);
    assert!(result.dry_run);
    assert!(result.would_change);
    assert_eq!(result.bytes_written, 0);
    assert!(result.change_set.is_none(), "dry run 不产生可回滚记录");
    let summary = result.change_summary.expect("summary");
    assert_eq!(summary.lines_added, 1);
    assert_eq!(summary.lines_removed, 1);
    assert_eq!(
        fs::read_to_string(ws.join("code.txt")).expect("read back"),
        "keep\nold\n",
        "dry run 不能改动磁盘"
    );
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn oversized_text_is_written_but_marked_non_reversible() {
    // 以前超过可逆上限直接失败，等于「太大就不给写」。现在照写，只是标明不可回滚。
    let (base, ws) = unique_workspace();
    let big = "x".repeat(REVERSIBLE_MAX_BYTES + 1024);

    let result = write_workspace_file_blocking_with_options(
        "big.txt".to_string(),
        big.clone(),
        Some("create".to_string()),
        root_arg(&ws),
        None,
        None,
        None,
    )
    .expect("large write");

    assert!(result.ok, "错误: {:?}", result.error);
    assert_eq!(result.bytes_written, big.len());
    assert!(!result.reversible);
    assert!(result
        .reversible_reason
        .as_deref()
        .unwrap_or_default()
        .contains("reversible"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn absent_max_bytes_allows_writes_past_the_old_default() {
    // max_bytes 已不在模型可见的 schema 里；不传必须等于「用最大上限」，
    // 否则工具层放行的内容会在 host 侧被静默拒绝。
    let (base, ws) = unique_workspace();
    let content = "y".repeat(600 * 1024);

    let result = write_workspace_file_blocking(
        "medium.txt".to_string(),
        content.clone(),
        Some("create".to_string()),
        None,
        None,
        None, // max_bytes 缺省
        None,
        root_arg(&ws),
    )
    .expect("write");

    assert!(result.ok, "600KB 不应被拒: {:?}", result.error);
    assert_eq!(result.bytes_written, content.len());
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn change_summary_reports_the_edited_region_only() {
    let before = "a\nb\nc\nd\ne\n";
    let after = "a\nb\nCHANGED\nd\ne\n";
    let summary = compute_change_summary(Some(before), after);

    assert_eq!(summary.lines_added, 1);
    assert_eq!(summary.lines_removed, 1);
    assert_eq!(summary.before_lines, 5);
    assert_eq!(summary.after_lines, 5);
    assert!(!summary.approximate);
    assert!(!summary.diff_truncated);
    let diff = summary.diff.expect("diff present");
    assert!(diff.contains("-c"), "diff 应含删除行: {diff}");
    assert!(diff.contains("+CHANGED"), "diff 应含新增行: {diff}");
    assert!(!diff.contains("+a"), "未变动的头部不应进 diff: {diff}");
}

#[test]
fn change_summary_for_a_new_file_counts_every_line_as_added() {
    let summary = compute_change_summary(None, "one\ntwo\n");
    assert_eq!(summary.lines_added, 2);
    assert_eq!(summary.lines_removed, 0);
    assert_eq!(summary.before_lines, 0);
    assert_eq!(summary.after_lines, 2);
}

#[test]
fn identical_content_reports_no_change_and_no_diff() {
    let summary = compute_change_summary(Some("same\n"), "same\n");
    assert_eq!(summary.lines_added, 0);
    assert_eq!(summary.lines_removed, 0);
    assert!(summary.diff.is_none());
}

#[test]
fn oversized_edits_degrade_to_an_approximate_block_summary() {
    // 超出 LCS 预算时不能假装算得出最小 diff：整段按替换上报并标记 approximate。
    let before: String = (0..1200).map(|index| format!("before {index}\n")).collect();
    let after: String = (0..1200).map(|index| format!("after {index}\n")).collect();
    let summary = compute_change_summary(Some(&before), &after);

    assert!(summary.approximate, "应降级为近似摘要");
    assert_eq!(summary.lines_removed, 1200);
    assert_eq!(summary.lines_added, 1200);
    assert!(summary.diff_truncated, "diff 应被截断");
    let diff = summary.diff.expect("diff present");
    // 头部 hunk 行 + 截断提示行，所以比纯 diff 预算多两行。
    assert!(diff.lines().count() <= 62);
    assert!(diff.contains("more diff lines"));
}

#[test]
fn successful_overwrite_returns_a_change_summary() {
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.txt"), "keep\nold\n").expect("seed");

    let result = write_workspace_file_blocking(
        "code.txt".to_string(),
        "keep\nnew\n".to_string(),
        Some("overwrite".to_string()),
        None,
        None,
        None,
        None,
        root_arg(&ws),
    )
    .expect("overwrite");

    let summary = result.change_summary.expect("summary present");
    assert_eq!(summary.lines_added, 1);
    assert_eq!(summary.lines_removed, 1);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn successful_write_returns_persisted_change_set() {
    let (base, ws) = unique_workspace();
    let journal = base.join("journal");
    let result = write_workspace_file_blocking_with_journal(
        "new.txt".to_string(),
        "content".to_string(),
        Some("create".to_string()),
        None,
        None,
        None,
        None,
        None,
        root_arg(&ws),
        None,
        None,
        None,
        Some((
            journal.clone(),
            WorkspaceChangeContext {
                change_id: "write-change".to_string(),
                session_id: "session".to_string(),
                run_id: "run".to_string(),
                tool_call_id: "call".to_string(),
            },
        )),
        "write-change".to_string(),
    )
    .expect("write journaled file");

    assert_eq!(
        result.change_set.as_ref().map(|change| change.id.as_str()),
        Some("write-change")
    );
    assert!(journal.join("write-change.json").is_file());
    let _ = fs::remove_dir_all(&base);
}
