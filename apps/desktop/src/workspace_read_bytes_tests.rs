use super::*;
use crate::workspace_read::test_support::{root_arg, unique_workspace};

#[test]
fn read_file_returns_content() {
    // read_file 读回磁盘上真实文件的完整内容，path 为 workspace 相对。
    let (base, ws) = unique_workspace();
    fs::write(ws.join("notes.txt"), "hello read world").expect("seed file");

    let result = read_workspace_file_blocking("notes.txt".to_string(), None, root_arg(&ws))
        .expect("read should succeed");
    assert_eq!(result.content, "hello read world");
    assert!(!result.truncated);
    assert_eq!(
        result.content_hash,
        Some(content_sha256(b"hello read world"))
    );
    assert_eq!(result.path, "notes.txt", "path 应为 workspace 相对路径");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn read_file_supports_lossless_byte_offset_paging() {
    let (base, ws) = unique_workspace();
    let content = "ab你cd";
    fs::write(ws.join("paged.txt"), content).expect("seed paged file");

    let first = read_workspace_file_blocking_with_access_at(
        "paged.txt".to_string(),
        Some(4),
        Some(0),
        root_arg(&ws),
        false,
    )
    .expect("first chunk");
    assert_eq!(first.content, "ab");
    assert_eq!(first.offset, 0);
    assert_eq!(first.next_offset, Some(2));
    assert_eq!(first.total_bytes, content.len() as u64);
    assert!(first.truncated);
    // 首段即使被截断也要给出【整文件】哈希：否则大文件永远拿不到 contentHash，
    // 只能裸覆盖。注意它必须等于整个文件的哈希，而不是本段 "ab" 的哈希。
    assert_eq!(
        first.content_hash,
        Some(content_sha256(content.as_bytes())),
        "首段应返回整文件哈希"
    );
    assert_ne!(
        first.content_hash,
        Some(content_sha256(b"ab")),
        "不能是本段内容的哈希"
    );

    let second = read_workspace_file_blocking_with_access_at(
        "paged.txt".to_string(),
        Some(4),
        first.next_offset,
        root_arg(&ws),
        false,
    )
    .expect("second chunk");
    assert_eq!(second.content, "你c");
    assert_eq!(second.offset, 2);
    assert_eq!(second.next_offset, Some(6));

    let third = read_workspace_file_blocking_with_access_at(
        "paged.txt".to_string(),
        Some(4),
        second.next_offset,
        root_arg(&ws),
        false,
    )
    .expect("third chunk");
    assert_eq!(third.content, "d");
    assert!(!third.truncated);
    assert_eq!(third.next_offset, None);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn content_hash_is_only_offered_on_the_opening_chunk() {
    // 续读段拿不到哈希是对的：它描述整个文件，只在「我正要开始读这个文件」时有意义，
    // 每段都重算一遍纯属浪费。
    let (base, ws) = unique_workspace();
    let content = "0123456789";
    fs::write(ws.join("paged.txt"), content).expect("seed");

    let tail = read_workspace_file_blocking_with_access_at(
        "paged.txt".to_string(),
        Some(4),
        Some(4),
        root_arg(&ws),
        false,
    )
    .expect("tail chunk");

    assert_eq!(tail.offset, 4);
    assert_eq!(tail.content_hash, None);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn content_hash_is_skipped_past_the_writable_ceiling() {
    // 超过 write_file 上限的文件没有工具能整体覆盖，给出哈希也用不上，
    // 不值得为此把整个文件扫一遍。
    let (base, ws) = unique_workspace();
    let oversized = "y".repeat((MAX_HASH_BYTES + 1) as usize);
    fs::write(ws.join("huge.txt"), &oversized).expect("seed huge file");

    let result = read_workspace_file_blocking("huge.txt".to_string(), Some(64), root_arg(&ws))
        .expect("huge read should still succeed");

    assert!(result.truncated);
    assert_eq!(result.total_bytes, oversized.len() as u64);
    assert_eq!(result.content_hash, None, "超出可写上限不再计算哈希");
    assert_eq!(result.content.len(), 64, "内容本身照常按 maxBytes 返回");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn opening_chunk_hash_round_trips_as_a_write_guard() {
    // 这条锁的是端到端契约：read_file 首段给出的哈希，必须正是 write_file 覆盖
    // 该文件时校验的那一个。两边算法漂移会让大文件的乐观锁静默失效。
    let (base, ws) = unique_workspace();
    let content = "line one\nline two\n".repeat(20_000); // 远超单次读取上限
    fs::write(ws.join("big.txt"), &content).expect("seed");

    let first = read_workspace_file_blocking("big.txt".to_string(), Some(100), root_arg(&ws))
        .expect("opening chunk");
    assert!(
        first.truncated,
        "该文件必须触发截断，否则这个用例没测到点子上"
    );

    let hash = first.content_hash.expect("opening chunk carries a hash");
    // write_file 侧对完整文件内容做同样计算。
    assert_eq!(hash, content_sha256(content.as_bytes()));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn trace_read_has_a_scoped_larger_ceiling() {
    let (base, ws) = unique_workspace();
    let trace_dir = ws.join(".webAgent-archive/traces");
    fs::create_dir_all(&trace_dir).expect("mkdir traces");
    let content = "x".repeat(MAX_READ_BYTES + 10_000);
    fs::write(trace_dir.join("root-01.trace.jsonl"), &content).expect("seed trace");
    fs::write(ws.join("ordinary.txt"), &content).expect("seed ordinary file");

    let trace = read_workspace_file_blocking(
        ".webAgent-archive/traces/root-01.trace.jsonl".to_string(),
        Some(content.len()),
        root_arg(&ws),
    )
    .expect("trace read should succeed");
    assert_eq!(trace.content.len(), content.len());
    assert!(!trace.truncated);
    assert_eq!(trace.content_hash, Some(content_sha256(content.as_bytes())));

    let ordinary = read_workspace_file_blocking(
        "ordinary.txt".to_string(),
        Some(content.len()),
        root_arg(&ws),
    )
    .expect("ordinary read should succeed");
    assert_eq!(ordinary.content.len(), MAX_READ_BYTES);
    assert!(ordinary.truncated);
    // 被读取上限截断不影响哈希：它描述的是整个文件，正是覆盖这个文件时要传的 guard。
    assert_eq!(
        ordinary.content_hash,
        Some(content_sha256(content.as_bytes()))
    );

    let _ = fs::remove_dir_all(&base);
}
