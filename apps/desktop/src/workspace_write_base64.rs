//! base64 内容的解码。

/// Minimal RFC 4648 base64 decoder. Vendored rather than pulled in as a dependency:
/// this is the only place the app needs base64, and the whole contract is 30 lines.
pub(super) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    // Whitespace is legal padding in transport; anything else must be real base64.
    let symbols: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let body = symbols.strip_suffix(b"==").unwrap_or_else(|| {
        symbols
            .strip_suffix(b"=")
            .unwrap_or(symbols.as_slice())
    });
    let padding = symbols.len() - body.len();
    if padding > 2 || (symbols.len() % 4 != 0 && padding > 0) {
        return Err("content is not valid base64: malformed padding".to_string());
    }

    let mut output = Vec::with_capacity(body.len() / 4 * 3 + 3);
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for byte in body {
        let Some(decoded) = value(*byte) else {
            return Err(format!(
                "content is not valid base64: unexpected character `{}`",
                char::from(*byte).escape_default()
            ));
        };
        accumulator = (accumulator << 6) | decoded;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    // Leftover bits must be zero padding; anything else means truncated input.
    if bits >= 6 || (accumulator & ((1 << bits) - 1)) != 0 {
        return Err("content is not valid base64: truncated input".to_string());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_write::pipeline::write_workspace_file_blocking_with_options;
    use crate::workspace_write::test_support::{root_arg, unique_workspace};
    use std::fs;

    #[test]
    fn base64_encoding_writes_real_binary_bytes() {
        // 二进制产出以前是硬拒（content 含 \0 直接失败），shell 侧又被写保护挡死，
        // 等于 agent 完全无法产出二进制文件。
        let (base, ws) = unique_workspace();
        let png_header = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

        let result = write_workspace_file_blocking_with_options(
            "assets/pixel.png".to_string(),
            "iVBORw0KGgoA/w==".to_string(),
            Some("create".to_string()),
            root_arg(&ws),
            Some("base64".to_string()),
            None,
            None,
        )
        .expect("binary write");

        assert!(result.ok, "错误: {:?}", result.error);
        assert_eq!(
            fs::read(ws.join("assets/pixel.png")).expect("read back"),
            png_header
        );
        // 二进制可以写，但 journal 只能存文本，所以必须明说它不可回滚。
        assert!(!result.reversible);
        assert!(result
            .reversible_reason
            .as_deref()
            .unwrap_or_default()
            .contains("binary"));
        assert!(result.change_summary.is_none(), "二进制没有行级 diff");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_carrying_text_stays_diffable_and_reversible() {
        let (base, ws) = unique_workspace();
        let result = write_workspace_file_blocking_with_options(
            "note.txt".to_string(),
            "aGVsbG8K".to_string(), // "hello\n"
            Some("create".to_string()),
            root_arg(&ws),
            Some("base64".to_string()),
            None,
            None,
        )
        .expect("base64 text write");

        assert!(result.ok);
        assert_eq!(
            fs::read_to_string(ws.join("note.txt")).expect("read back"),
            "hello\n"
        );
        assert!(result.reversible, "base64 承载的文本仍然可回滚");
        assert_eq!(
            result.change_summary.expect("summary").lines_added,
            1,
            "base64 承载的文本仍然有 diff"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn malformed_base64_is_rejected_before_touching_disk() {
        let (base, ws) = unique_workspace();
        // "a" 单字符只剩 6 个有效位，凑不出一个字节；"==" 是纯 padding；"!" 非法字符。
        for payload in ["not base64!", "a", "=="] {
            let result = write_workspace_file_blocking_with_options(
                "bad.bin".to_string(),
                payload.to_string(),
                Some("create".to_string()),
                root_arg(&ws),
                Some("base64".to_string()),
                None,
                None,
            )
            .expect("structured rejection");
            assert!(!result.ok, "`{payload}` 应被拒");
            assert!(result
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("base64"));
        }
        assert!(!ws.join("bad.bin").exists(), "被拒时不应留下文件");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_decoder_matches_rfc4648_vectors() {
        assert_eq!(decode_base64("").expect("empty"), b"");
        assert_eq!(decode_base64("Zg==").expect("f"), b"f");
        assert_eq!(decode_base64("Zm8=").expect("fo"), b"fo");
        assert_eq!(decode_base64("Zm9v").expect("foo"), b"foo");
        assert_eq!(decode_base64("Zm9vYmFy").expect("foobar"), b"foobar");
        // 传输中换行是合法的，内容里的换行不影响解码结果。
        assert_eq!(decode_base64("Zm9v\nYmFy").expect("wrapped"), b"foobar");
        // 省略 padding 是 RFC 4648 允许的，模型生成的 base64 未必带 `=`。
        assert_eq!(decode_base64("Zm8").expect("unpadded fo"), b"fo");
        assert_eq!(decode_base64("Zg").expect("unpadded f"), b"f");
    }
}
