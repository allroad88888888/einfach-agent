//! 覆盖/删除操作的乐观并发守卫：oldContent 与 expectedContentHash。

use sha2::{Digest, Sha256};

/// Verify an optimistic guard against content already staged in this transaction.
/// Accepts either the full previous text or its hash; the hash exists so a caller
/// does not have to resend a whole file to prove it read it.
pub(super) fn verify_staged_guard(
    current: &str,
    old_content: Option<&str>,
    expected_content_hash: Option<&str>,
) -> Result<(), String> {
    if old_content.is_some() && expected_content_hash.is_some() {
        return Err("pass either oldContent or expectedContentHash, not both".to_string());
    }
    if let Some(old_content) = old_content {
        if old_content != current {
            return Err("oldContent did not match current file content".to_string());
        }
    }
    if let Some(expected) = expected_content_hash {
        validate_content_hash(expected)?;
        if content_sha256(current.as_bytes()) != expected {
            return Err(
                "expectedContentHash did not match current file content; re-read the file and \
                 retry with the new contentHash"
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

fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
#[path = "workspace_patch_guard_tests.rs"]
mod tests;
