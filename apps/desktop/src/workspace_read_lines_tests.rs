use super::*;
use crate::workspace_read::read_workspace_file_blocking_at_lines;
use crate::workspace_read::test_support::{root_arg, unique_workspace};
use std::path::Path;

fn read_lines(
    ws: &Path,
    path: &str,
    start_line: Option<usize>,
    line_count: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_blocking_at_lines(
        path.to_string(),
        max_bytes,
        None,
        start_line,
        line_count,
        root_arg(ws),
        false,
    )
}

#[test]
fn reads_an_addressed_line_range() {
    // rg_search 报「第 3 行」时，这一步应当是一次直接调用，而不是整段读回来数行。
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "one\ntwo\nthree\nfour\nfive\n").expect("seed");

    let result = read_lines(&ws, "code.rs", Some(3), Some(2), None).expect("line read");

    assert_eq!(result.content, "three\nfour\n");
    assert_eq!(result.start_line, Some(3));
    assert_eq!(result.end_line, Some(4));
    assert_eq!(result.next_line, Some(5));
    assert_eq!(result.total_lines, Some(5));
    assert!(result.truncated, "后面还有第 5 行");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn line_paging_walks_the_whole_file_via_next_line() {
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "a\nb\nc\nd\n").expect("seed");

    let mut cursor = Some(1);
    let mut seen = String::new();
    while let Some(start) = cursor {
        let chunk = read_lines(&ws, "code.rs", Some(start), Some(3), None).expect("chunk");
        seen.push_str(&chunk.content);
        cursor = chunk.next_line;
    }

    assert_eq!(seen, "a\nb\nc\nd\n", "分页拼接必须与原文逐字节一致");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn line_reads_preserve_crlf_so_content_stays_usable_as_old_text() {
    // 把行尾规范化成 LF 会让读到的内容无法当作 apply_patch 的 oldText 使用。
    let (base, ws) = unique_workspace();
    fs::write(ws.join("win.txt"), "alpha\r\nbeta\r\ngamma\r\n").expect("seed");

    let result = read_lines(&ws, "win.txt", Some(2), Some(1), None).expect("line read");

    assert_eq!(result.content, "beta\r\n");
    assert_eq!(result.total_lines, Some(3));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn line_count_defaults_to_the_rest_of_the_file() {
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "a\nb\nc\n").expect("seed");

    let result = read_lines(&ws, "code.rs", Some(2), None, None).expect("line read");

    assert_eq!(result.content, "b\nc\n");
    assert_eq!(result.end_line, Some(3));
    assert_eq!(result.next_line, None);
    assert!(!result.truncated);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn max_bytes_truncates_line_reads_on_whole_lines() {
    // 半行内容既不能用作 oldText，也无法让模型判断自己看到了什么。
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "aaaa\nbbbb\ncccc\n").expect("seed");

    let result = read_lines(&ws, "code.rs", Some(1), Some(3), Some(7)).expect("line read");

    assert_eq!(result.content, "aaaa\n", "只返回完整的行");
    assert_eq!(result.end_line, Some(1));
    assert_eq!(result.next_line, Some(2));
    assert!(result.truncated);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn opening_line_read_still_carries_the_file_hash() {
    let (base, ws) = unique_workspace();
    let content = "one\ntwo\nthree\n";
    fs::write(ws.join("code.rs"), content).expect("seed");

    let first = read_lines(&ws, "code.rs", Some(1), Some(1), None).expect("first line");
    assert_eq!(first.content_hash, Some(content_sha256(content.as_bytes())));

    let later = read_lines(&ws, "code.rs", Some(2), Some(1), None).expect("later line");
    assert_eq!(later.content_hash, None, "非起始行不重复给出整文件哈希");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn line_addressing_rejects_conflicting_or_out_of_range_input() {
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "a\nb\n").expect("seed");

    let both = read_workspace_file_blocking_at_lines(
        "code.rs".to_string(),
        None,
        Some(2),
        Some(1),
        None,
        root_arg(&ws),
        false,
    )
    .expect_err("offset 与 startLine 不能同时给");
    assert!(both.contains("not both"));

    let zero = read_lines(&ws, "code.rs", Some(0), None, None).expect_err("行号是 1-based");
    assert!(zero.contains("1-based"));

    let past_end = read_lines(&ws, "code.rs", Some(9), None, None).expect_err("越过文件末尾应报错");
    assert!(past_end.contains("exceeds the file's 2 line(s)"));

    let empty_count =
        read_lines(&ws, "code.rs", Some(1), Some(0), None).expect_err("lineCount 必须为正");
    assert!(empty_count.contains("greater than 0"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn byte_mode_is_untouched_by_line_addressing() {
    // 不传行参数时必须完全走原路径，字节分页的既有行为不受影响。
    let (base, ws) = unique_workspace();
    fs::write(ws.join("code.rs"), "a\nb\nc\n").expect("seed");

    let result = read_workspace_file_blocking_at_lines(
        "code.rs".to_string(),
        Some(2),
        Some(0),
        None,
        None,
        root_arg(&ws),
        false,
    )
    .expect("byte read");

    assert_eq!(result.content, "a\n");
    assert_eq!(result.next_offset, Some(2));
    assert_eq!(result.start_line, None, "字节模式不报行号");
    assert_eq!(result.total_lines, None);
    let _ = fs::remove_dir_all(&base);
}
