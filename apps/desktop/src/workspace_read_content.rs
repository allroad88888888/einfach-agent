//! 读取到的字节流的二进制判定、UTF-8 解码与内容哈希。

use super::paths::display_path;
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

pub(super) fn reject_binary_bytes(bytes: &[u8], path: &Path) -> Result<(), String> {
    if bytes.iter().any(|byte| *byte == 0) {
        return Err(format!(
            "refusing to read binary file `{}`",
            display_path(path)
        ));
    }
    Ok(())
}

pub(super) fn decode_utf8(
    bytes: &[u8],
    allow_incomplete_tail: bool,
    path: &Path,
) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(value) => Ok(value.to_string()),
        Err(err) if allow_incomplete_tail && err.error_len().is_none() => {
            Ok(String::from_utf8_lossy(&bytes[..err.valid_up_to()]).into_owned())
        }
        Err(_) => Err(format!(
            "refusing to read non-UTF-8 file `{}`",
            display_path(path)
        )),
    }
}

pub(super) fn cap_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect()
}
