use crate::model_provider_route::ProviderTarget;
use crate::model_proxy_body::ProviderRequestBody;
use crate::model_request_registry::validate_model_request_id;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

const MAX_PROVIDER_WIRE_REQUEST_BYTES: usize = 56 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProviderRequestInput {
    pub target: ProviderTarget,
    pub body: ProviderRequestBody,
    pub request_id: String,
}

struct WireSizeWriter {
    remaining: usize,
}

impl Write for WireSizeWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "provider request exceeds wire limit",
            ));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn invalid_envelope() -> String {
    "模型请求格式无效".to_string()
}

fn validate_provider_request_envelope_with_limit(
    input: &ModelProviderRequestInput,
    max_bytes: usize,
) -> Result<(), String> {
    validate_model_request_id(&input.request_id)?;
    let mut writer = WireSizeWriter {
        remaining: max_bytes,
    };
    serde_json::to_writer(&mut writer, input).map_err(|_| invalid_envelope())
}

/** Caps the complete canonical IPC envelope before body decoding or allocation. */
pub fn validate_provider_request_envelope(input: &ModelProviderRequestInput) -> Result<(), String> {
    validate_provider_request_envelope_with_limit(input, MAX_PROVIDER_WIRE_REQUEST_BYTES)
}

#[cfg(test)]
mod tests {
    use super::{validate_provider_request_envelope_with_limit, ModelProviderRequestInput};

    fn request() -> ModelProviderRequestInput {
        serde_json::from_str(
            r#"{"target":{"provider":"deepseek","scope":"default","method":"POST","path":"/chat/completions"},"body":{"kind":"json","json":"{}"},"requestId":"request-1"}"#,
        )
        .expect("deserialize canonical request")
    }

    #[test]
    fn uses_the_shared_complete_canonical_byte_boundary() {
        let request = request();
        let encoded = serde_json::to_vec(&request).expect("serialize canonical request");
        assert_eq!(encoded.len(), 154);
        assert!(validate_provider_request_envelope_with_limit(&request, encoded.len()).is_ok());
        assert!(
            validate_provider_request_envelope_with_limit(&request, encoded.len() - 1).is_err()
        );
    }

    #[test]
    fn rejects_request_ids_outside_the_registry_contract() {
        let mut request = request();
        request.request_id = "bad request".to_string();
        assert!(validate_provider_request_envelope_with_limit(&request, usize::MAX).is_err());
    }
}
