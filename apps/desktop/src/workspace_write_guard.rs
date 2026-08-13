//! 写前乐观守卫：用锁内读到的旧内容校验调用方声明的前置状态。

use super::before::BeforeContent;
use sha2::{Digest, Sha256};

/// Verifies the optimistic guard against content already read inside the path
/// lock, rather than re-reading the file, so no window remains between the check
/// and the write it protects.
pub(super) fn verify_expected_content(
    before: &BeforeContent,
    expected: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    if expected.is_some() && expected_hash.is_some() {
        return Err("pass either expectedOldContent or expectedContentHash, not both".to_string());
    }
    if expected.is_none() && expected_hash.is_none() {
        return Ok(());
    }

    let current = match before {
        BeforeContent::Text(value) => value.as_str(),
        BeforeContent::Missing => {
            return Err(
                "failed to read existing file for optimistic guard: file does not exist".to_string(),
            )
        }
        BeforeContent::Unsupported(reason) => {
            return Err(format!(
                "failed to read existing file for optimistic guard: {reason}"
            ))
        }
    };
    if let Some(expected) = expected {
        if current != expected {
            return Err(format!(
                "expectedOldContent does not match current file content \
                 (expected_bytes={}, current_bytes={}, first_mismatch_byte={}, \
                 expected_trailing_lf={}, current_trailing_lf={}). Re-read the complete, \
                 untruncated file and pass it exactly, including final newlines; do not pass a snippet",
                expected.len(),
                current.len(),
                first_mismatch_byte(expected.as_bytes(), current.as_bytes()),
                trailing_lf_count(expected.as_bytes()),
                trailing_lf_count(current.as_bytes()),
            ));
        }
    }
    if let Some(expected_hash) = expected_hash {
        validate_content_hash(expected_hash)?;
        if content_sha256(current.as_bytes()) != expected_hash {
            return Err(
                "expectedContentHash does not match current file content; the file changed after \
                 read_file. Re-read it and retry with the new contentHash"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_content_hash(value: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(
            "expectedContentHash must use sha256:<64 lowercase hex characters>".to_string(),
        );
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "expectedContentHash must use sha256:<64 lowercase hex characters>".to_string(),
        );
    }
    Ok(())
}

pub(super) fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn first_mismatch_byte(expected: &[u8], current: &[u8]) -> usize {
    expected
        .iter()
        .zip(current)
        .position(|(left, right)| left != right)
        .unwrap_or(expected.len().min(current.len()))
}

fn trailing_lf_count(content: &[u8]) -> usize {
    content
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\n')
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_write::before::read_before_content;
    use crate::workspace_write::pipeline::{
        write_workspace_file_blocking, write_workspace_file_blocking_with_journal,
    };
    use crate::workspace_write::test_support::{root_arg, unique_workspace};
    use std::fs;

    #[test]
    fn expected_old_content_mismatch_reports_exact_difference_shape() {
        let (base, ws) = unique_workspace();
        let target = ws.join("existing.txt");
        fs::write(&target, "line\n\n").expect("seed existing file");

        let error = verify_expected_content(&read_before_content(&target), Some("line\n"), None)
            .expect_err("different final newline count must reject");

        assert!(error.contains("expected_bytes=5"));
        assert!(error.contains("current_bytes=6"));
        assert!(error.contains("first_mismatch_byte=5"));
        assert!(error.contains("expected_trailing_lf=1"));
        assert!(error.contains("current_trailing_lf=2"));
        assert!(error.contains("do not pass a snippet"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn expected_content_hash_accepts_current_and_rejects_stale_content() {
        let (base, ws) = unique_workspace();
        let target = ws.join("existing.txt");
        fs::write(&target, "old\n\n").expect("seed existing file");
        let current_hash = content_sha256(b"old\n\n");

        verify_expected_content(&read_before_content(&target), None, Some(&current_hash))
            .expect("matching content hash should pass");
        fs::write(&target, "changed\n").expect("modify existing file");
        let error = verify_expected_content(&read_before_content(&target), None, Some(&current_hash))
            .expect_err("stale content hash must reject");

        assert!(error.contains("file changed after read_file"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn upsert_with_guard_refuses_to_create_a_missing_file() {
        // guard 表达的是"我基于某个已知版本改"。文件不存在时静默新建会丢掉这个前提。
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking(
            "absent.txt".to_string(),
            "x".to_string(),
            Some("upsert".to_string()),
            Some("expected old".to_string()),
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("structured rejection");

        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("does not exist"));
        assert!(!ws.join("absent.txt").exists(), "被拒时不应留下文件");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dry_run_still_reports_a_guard_mismatch() {
        // dry run 的价值就在于能提前知道这次写会不会被拒。
        let (base, ws) = unique_workspace();
        let target = ws.join("code.txt");
        fs::write(&target, "current\n").expect("seed");

        let result = write_workspace_file_blocking_with_journal(
            "code.txt".to_string(),
            "next\n".to_string(),
            Some("overwrite".to_string()),
            Some("stale\n".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
            None,
            None,
            Some(true),
            None,
            "dry-guard".to_string(),
        )
        .expect("structured rejection");

        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("expectedOldContent"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn append_accepts_an_optimistic_guard() {
        // 分块追加失败重试时，没有前置条件就无法区分「上次写丢了」和「上次写成功了」。
        let (base, ws) = unique_workspace();
        let target = ws.join("log.jsonl");
        fs::write(&target, "one\n").expect("seed");
        let current_hash = content_sha256(b"one\n");

        let appended = write_workspace_file_blocking(
            "log.jsonl".to_string(),
            "two\n".to_string(),
            Some("append".to_string()),
            None,
            None,
            None,
            None,
            root_arg(&ws),
        )
        .expect("plain append");
        assert!(appended.ok);

        // 文件已经变了，旧 hash 必须挡住重复追加。
        let stale = write_workspace_file_blocking_with_journal(
            "log.jsonl".to_string(),
            "two\n".to_string(),
            Some("append".to_string()),
            None,
            Some(current_hash),
            None,
            None,
            None,
            root_arg(&ws),
            None,
            None,
            None,
            None,
            "append-guard".to_string(),
        )
        .expect("structured rejection");

        assert!(!stale.ok, "过期 hash 必须拒绝重复追加");
        assert_eq!(
            fs::read_to_string(&target).expect("read back"),
            "one\ntwo\n",
            "被拒的追加不能落盘"
        );
        let _ = fs::remove_dir_all(&base);
    }
}
