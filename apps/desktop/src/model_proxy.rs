use crate::model_credentials::active_model_credential;
use crate::model_provider::ModelProvider;
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024 * 1024;
const MODEL_REQUEST_TIMEOUT_SECONDS: u64 = 120;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChatCompletionsInput {
    pub provider: ModelProvider,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ModelProxyEvent {
    Response {
        status: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

fn valid_request_body(body: &str) -> Result<(), String> {
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("模型请求过大".to_string());
    }
    serde_json::from_str::<serde_json::Value>(body)
        .map(|_| ())
        .map_err(|_| "模型请求格式无效".to_string())
}

#[tauri::command]
pub async fn model_chat_completions(
    input: ModelChatCompletionsInput,
    events: Channel<ModelProxyEvent>,
) -> Result<(), String> {
    valid_request_body(&input.body)?;
    let (api_key, _) = active_model_credential(input.provider).await?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(
            MODEL_REQUEST_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|_| "无法初始化模型网络连接")?;
    let response = client
        .post(input.provider.chat_completions_url())
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .body(input.body)
        .send()
        .await
        .map_err(|_| "模型服务请求失败")?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    events
        .send(ModelProxyEvent::Response {
            status,
            content_type,
        })
        .map_err(|_| "模型响应通道已关闭")?;

    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        match chunk {
            Ok(bytes) => events
                .send(ModelProxyEvent::Chunk {
                    bytes: bytes.to_vec(),
                })
                .map_err(|_| "模型响应通道已关闭")?,
            Err(_) => {
                let _ = events.send(ModelProxyEvent::Error {
                    message: "模型响应中断".to_string(),
                });
                return Ok(());
            }
        }
    }
    events
        .send(ModelProxyEvent::End)
        .map_err(|_| "模型响应通道已关闭".to_string())
}

#[cfg(test)]
mod tests {
    use super::valid_request_body;

    #[test]
    fn validates_json_before_forwarding_it() {
        assert!(valid_request_body("{\"model\":\"x\"}").is_ok());
        assert!(valid_request_body("not json").is_err());
        assert!(valid_request_body(&"x".repeat(4 * 1024 * 1024 + 1)).is_err());
    }
}
