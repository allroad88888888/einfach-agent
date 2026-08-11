use crate::model_provider::{ModelProvider, ProviderScope};
use crate::model_provider_route::{
    resolve_provider_target, ProviderMethod, ProviderTarget, ResolvedProviderTarget,
};
use crate::model_proxy_body::{prepare_provider_body, PreparedProviderBody, ProviderRequestBody};
use crate::model_proxy_envelope::{validate_provider_request_envelope, ModelProviderRequestInput};
use crate::model_proxy_http::send_provider_request;
use crate::model_request_registry::ModelRequestCanceller;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelChatCompletionsInput {
    pub provider: ModelProvider,
    pub body: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ModelProxyEvent {
    Started,
    Response {
        status: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

async fn prepare_body(
    body: ProviderRequestBody,
    target: &ResolvedProviderTarget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Option<PreparedProviderBody>, String> {
    let expected = target.body_kind;
    let task = tauri::async_runtime::spawn_blocking(move || prepare_provider_body(body, expected));
    tokio::select! {
        _ = cancellation.cancelled() => Ok(None),
        prepared = task => prepared
            .map_err(|_| "处理模型请求失败".to_string())?
            .map(Some),
    }
}

async fn run_provider_request(
    app: &AppHandle,
    input: ModelProviderRequestInput,
    events: &Channel<ModelProxyEvent>,
    cancellations: &ModelRequestCanceller,
) -> Result<(), String> {
    validate_provider_request_envelope(&input)?;
    let target = resolve_provider_target(&input.target)?;
    let cancellation = cancellations.register(&input.request_id)?;
    let result = if events.send(ModelProxyEvent::Started).is_err() {
        Err("模型响应通道已关闭".to_string())
    } else {
        match prepare_body(input.body, &target, &cancellation).await {
            Ok(Some(body)) => send_provider_request(app, target, body, events, &cancellation).await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        }
    };
    cancellations.finish(&input.request_id);
    result
}

#[tauri::command]
pub async fn model_provider_request(
    app: AppHandle,
    input: ModelProviderRequestInput,
    events: Channel<ModelProxyEvent>,
    cancellations: State<'_, ModelRequestCanceller>,
) -> Result<(), String> {
    run_provider_request(&app, input, &events, cancellations.inner()).await
}

#[tauri::command]
pub fn cancel_model_provider_request(
    request_id: String,
    cancellations: State<'_, ModelRequestCanceller>,
) -> Result<bool, String> {
    cancellations.cancel(&request_id)
}

/** Compatibility command for existing DeepSeek and GLM renderer builds. */
#[tauri::command]
pub async fn model_chat_completions(
    app: AppHandle,
    input: ModelChatCompletionsInput,
    events: Channel<ModelProxyEvent>,
    cancellations: State<'_, ModelRequestCanceller>,
) -> Result<(), String> {
    let input = ModelProviderRequestInput {
        target: ProviderTarget {
            provider: input.provider,
            scope: ProviderScope::Default,
            method: ProviderMethod::Post,
            path: "/chat/completions".to_string(),
        },
        body: ProviderRequestBody::Json { json: input.body },
        request_id: input.request_id,
    };
    run_provider_request(&app, input, &events, cancellations.inner()).await
}

/** Compatibility cancellation command for existing renderer builds. */
#[tauri::command]
pub fn cancel_model_chat_completions(
    request_id: String,
    cancellations: State<'_, ModelRequestCanceller>,
) -> Result<bool, String> {
    cancellations.cancel(&request_id)
}
