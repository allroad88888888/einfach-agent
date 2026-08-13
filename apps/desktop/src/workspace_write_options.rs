//! 把 IPC 传来的可选入参解析成内部写入选项（模式、编码、大小上限）。

use super::limits::MAX_BYTES;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum WriteMode {
    Create,
    Overwrite,
    Append,
    Upsert,
}

pub(super) fn parse_mode(mode: Option<&str>) -> Result<WriteMode, String> {
    match mode.unwrap_or("create") {
        "create" => Ok(WriteMode::Create),
        "overwrite" => Ok(WriteMode::Overwrite),
        "append" => Ok(WriteMode::Append),
        "upsert" => Ok(WriteMode::Upsert),
        other => Err(format!(
            "invalid mode `{other}`; expected `create`, `overwrite`, `upsert`, or `append`"
        )),
    }
}

pub(super) fn normalize_max_bytes(max_bytes: Option<usize>) -> usize {
    match max_bytes {
        Some(value) if value > 0 => value.min(MAX_BYTES),
        _ => MAX_BYTES,
    }
}

/// How `content` is carried over IPC. Base64 exists so the tool can produce binary
/// artifacts at all; JSON strings cannot hold arbitrary bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ContentEncoding {
    Utf8,
    Base64,
}

pub(super) fn parse_encoding(encoding: Option<&str>) -> Result<ContentEncoding, String> {
    match encoding.unwrap_or("utf8") {
        "utf8" | "utf-8" => Ok(ContentEncoding::Utf8),
        "base64" => Ok(ContentEncoding::Base64),
        other => Err(format!(
            "invalid encoding `{other}`; expected `utf8` or `base64`"
        )),
    }
}
