use super::*;
use crate::workspace_read::limits::MAX_READ_BYTES;
use crate::workspace_read::test_support::{root_arg, unique_workspace};
use std::io::Write;

#[test]
fn run_index_pages_from_newest_without_truncating_large_unique_history() {
    let (base, ws) = unique_workspace();
    let index_dir = ws.join(".webAgent-archive/index");
    fs::create_dir_all(&index_dir).expect("mkdir index");
    let content = (0..4_000)
        .map(|index| {
            format!(
                r#"{{"conversationId":"c-{index}","runId":"r-{index}","padding":"{}"}}"#,
                "x".repeat(32)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        content.len() > MAX_READ_BYTES,
        "fixture must exceed generic read cap"
    );
    fs::write(index_dir.join("runs.jsonl"), format!("{content}\n")).expect("seed runs index");

    let first =
        read_workspace_run_index_page_blocking(None, Some(2), root_arg(&ws)).expect("first page");
    assert_eq!(first.lines.len(), 2);
    assert_eq!(first.lines[0].line_number, 4_000);
    assert!(first.lines[0].content.contains(r#""runId":"r-3999""#));
    assert!(first.has_more);

    let second =
        read_workspace_run_index_page_blocking(first.cursor.clone(), Some(2), root_arg(&ws))
            .expect("second page");
    assert_eq!(second.lines[0].line_number, 3_998);
    assert!(second.lines[0].content.contains(r#""runId":"r-3997""#));
    assert_eq!(second.snapshot, first.snapshot);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn run_index_cursor_fails_closed_after_append() {
    let (base, ws) = unique_workspace();
    let index_dir = ws.join(".webAgent-archive/index");
    fs::create_dir_all(&index_dir).expect("mkdir index");
    let index_path = index_dir.join("runs.jsonl");
    fs::write(&index_path, "{\"runId\":\"r1\"}\n{\"runId\":\"r2\"}\n").expect("seed runs index");
    let first =
        read_workspace_run_index_page_blocking(None, Some(1), root_arg(&ws)).expect("first page");
    fs::OpenOptions::new()
        .append(true)
        .open(&index_path)
        .expect("open append")
        .write_all(b"{\"runId\":\"r3\"}\n")
        .expect("append run");

    let error = read_workspace_run_index_page_blocking(first.cursor, Some(1), root_arg(&ws))
        .err()
        .expect("stale cursor must fail");
    assert!(error.contains("changed while paging"), "actual: {error}");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn run_index_cursor_fails_closed_after_compaction_replacement() {
    let (base, ws) = unique_workspace();
    let index_dir = ws.join(".webAgent-archive/index");
    fs::create_dir_all(&index_dir).expect("mkdir index");
    let index_path = index_dir.join("runs.jsonl");
    fs::write(&index_path, "{\"runId\":\"old\"}\n{\"runId\":\"latest\"}\n")
        .expect("seed runs index");
    let first =
        read_workspace_run_index_page_blocking(None, Some(1), root_arg(&ws)).expect("first page");
    let replacement = index_dir.join("runs.jsonl.compact.tmp");
    fs::write(&replacement, "{\"runId\":\"latest\"}\n").expect("write compacted index");
    fs::rename(&replacement, &index_path).expect("replace with compacted index");

    let error = read_workspace_run_index_page_blocking(first.cursor, Some(1), root_arg(&ws))
        .err()
        .expect("cursor from pre-compaction snapshot must fail");
    assert!(error.contains("changed while paging"), "actual: {error}");

    let _ = fs::remove_dir_all(&base);
}
