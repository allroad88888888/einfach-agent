//! 补丁文本输入的大小与二进制上限。

pub(super) const MAX_FILE_BYTES: usize = 1024 * 1024;

pub(super) fn validate_non_empty_text_input(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} must be non-empty"));
    }
    validate_text_input(label, value)
}

pub(super) fn validate_text_input(label: &str, value: &str) -> Result<(), String> {
    if value.as_bytes().len() > MAX_FILE_BYTES {
        return Err(format!("{label} exceeds {} byte limit", MAX_FILE_BYTES));
    }
    if value.contains('\0') {
        return Err(format!("{label} appears to be binary"));
    }
    Ok(())
}

pub(super) fn validate_file_text(label: &str, value: &str) -> Result<(), String> {
    validate_text_input(label, value)
}
