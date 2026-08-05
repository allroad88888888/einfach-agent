use crate::model_provider_route::ProviderBodyKind;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};

const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_MULTIPART_PARTS: usize = 16;
const MAX_MULTIPART_FILES: usize = 8;
const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILE_BATCH_BYTES: usize = 40 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_TEXT_BATCH_BYTES: usize = 256 * 1024;
const MAX_PART_NAME_BYTES: usize = 64;
const MAX_FILE_NAME_BYTES: usize = 255;
const MAX_CONTENT_TYPE_BYTES: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProviderRequestBody {
    None,
    Json { json: String },
    Multipart { parts: Vec<ProviderMultipartPart> },
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderMultipartPart {
    Text {
        name: String,
        value: String,
    },
    File {
        name: String,
        file_name: String,
        content_type: String,
        bytes_base64: String,
    },
}

pub enum PreparedProviderBody {
    None,
    Json(String),
    Multipart(Form),
}

impl ProviderRequestBody {
    fn kind(&self) -> ProviderBodyKind {
        match self {
            Self::None => ProviderBodyKind::None,
            Self::Json { .. } => ProviderBodyKind::Json,
            Self::Multipart { .. } => ProviderBodyKind::Multipart,
        }
    }
}

fn invalid_body() -> String {
    "模型请求格式无效".to_string()
}

fn valid_part_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PART_NAME_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FILE_NAME_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn valid_content_type(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_CONTENT_TYPE_BYTES {
        return false;
    }
    let mut segments = value.split('/');
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    };
    matches!((segments.next(), segments.next(), segments.next()), (Some(left), Some(right), None) if valid_segment(left) && valid_segment(right))
}

fn prepare_multipart(parts: Vec<ProviderMultipartPart>) -> Result<Form, String> {
    if parts.is_empty() || parts.len() > MAX_MULTIPART_PARTS {
        return Err(invalid_body());
    }
    let mut form = Form::new();
    let mut file_count = 0_usize;
    let mut file_bytes = 0_usize;
    let mut text_bytes = 0_usize;
    for part in parts {
        match part {
            ProviderMultipartPart::Text { name, value } => {
                text_bytes = text_bytes.saturating_add(value.len());
                if !valid_part_name(&name)
                    || value.len() > MAX_TEXT_BYTES
                    || text_bytes > MAX_TEXT_BATCH_BYTES
                {
                    return Err(invalid_body());
                }
                form = form.text(name, value);
            }
            ProviderMultipartPart::File {
                name,
                file_name,
                content_type,
                bytes_base64,
            } => {
                if !valid_part_name(&name)
                    || !valid_file_name(&file_name)
                    || !valid_content_type(&content_type)
                    || bytes_base64.len() > 4 * MAX_FILE_BYTES.div_ceil(3)
                {
                    return Err(invalid_body());
                }
                let bytes = BASE64.decode(bytes_base64).map_err(|_| invalid_body())?;
                file_count += 1;
                file_bytes = file_bytes.saturating_add(bytes.len());
                if bytes.is_empty()
                    || bytes.len() > MAX_FILE_BYTES
                    || file_count > MAX_MULTIPART_FILES
                    || file_bytes > MAX_FILE_BATCH_BYTES
                {
                    return Err(invalid_body());
                }
                let upload = Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(&content_type)
                    .map_err(|_| invalid_body())?;
                form = form.part(name, upload);
            }
        }
    }
    Ok(form)
}

pub fn prepare_provider_body(
    body: ProviderRequestBody,
    expected: ProviderBodyKind,
) -> Result<PreparedProviderBody, String> {
    if body.kind() != expected {
        return Err(invalid_body());
    }
    match body {
        ProviderRequestBody::None => Ok(PreparedProviderBody::None),
        ProviderRequestBody::Json { json } => {
            if json.len() > MAX_JSON_BYTES
                || serde_json::from_str::<serde_json::Value>(&json).is_err()
            {
                return Err(invalid_body());
            }
            Ok(PreparedProviderBody::Json(json))
        }
        ProviderRequestBody::Multipart { parts } => {
            prepare_multipart(parts).map(PreparedProviderBody::Multipart)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{prepare_provider_body, ProviderRequestBody};
    use crate::model_provider_route::ProviderBodyKind;

    fn body(source: &str) -> ProviderRequestBody {
        serde_json::from_str(source).expect("deserialize provider body")
    }

    #[test]
    fn validates_json_kind_and_size() {
        assert!(prepare_provider_body(
            body(r#"{"kind":"json","json":"{}"}"#),
            ProviderBodyKind::Json
        )
        .is_ok());
        assert!(prepare_provider_body(
            body(r#"{"kind":"json","json":"not-json"}"#),
            ProviderBodyKind::Json
        )
        .is_err());
        assert!(prepare_provider_body(body(r#"{"kind":"none"}"#), ProviderBodyKind::Json).is_err());
    }

    #[test]
    fn validates_multipart_metadata_and_base64() {
        let valid = body(
            r#"{"kind":"multipart","parts":[{"kind":"text","name":"note","value":"sample"},{"kind":"file","name":"file","fileName":"a.png","contentType":"image/png","bytesBase64":"AQID"}]}"#,
        );
        assert!(prepare_provider_body(valid, ProviderBodyKind::Multipart).is_ok());
        let invalid = body(
            r#"{"kind":"multipart","parts":[{"kind":"file","name":"../file","fileName":"a.png","contentType":"image/png","bytesBase64":"AQID"}]}"#,
        );
        assert!(prepare_provider_body(invalid, ProviderBodyKind::Multipart).is_err());
    }
}
