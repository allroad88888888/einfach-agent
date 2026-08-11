use crate::model_credential_config::ModelCredentialStore;
use crate::model_provider::{ModelProvider, ProviderScope};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MAX_API_KEY_LENGTH: usize = 1_024;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Config,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCredentialStatus {
    pub provider: ModelProvider,
    pub scope: ProviderScope,
    pub configured: bool,
    pub source: CredentialSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetModelCredentialInput {
    pub provider: ModelProvider,
    #[serde(default)]
    pub scope: ProviderScope,
    pub api_key: String,
}

#[derive(Clone, Copy)]
struct CredentialBinding {
    config_key: &'static str,
}

fn credential_binding(
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<CredentialBinding, String> {
    if !provider.accepts_scope(scope) {
        return Err("模型凭证作用域未获允许".to_string());
    }
    use ModelProvider::{Deepseek, Glm, Kimi};
    use ProviderScope::{Cn, Default};

    match (provider, scope) {
        (Deepseek, Default) => Ok(CredentialBinding {
            config_key: "deepseek:default",
        }),
        (Glm, Default) => Ok(CredentialBinding {
            config_key: "glm:default",
        }),
        (Kimi, Cn) => Ok(CredentialBinding {
            config_key: "kimi:cn",
        }),
        _ => Err("模型凭证作用域未获允许".to_string()),
    }
}

fn normalized_key(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty() && value.len() <= MAX_API_KEY_LENGTH).then_some(value)
}

async fn configured_model_credential(
    app: &AppHandle,
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<Option<(String, CredentialSource)>, String> {
    let binding = credential_binding(provider, scope)?;
    let store = ModelCredentialStore::from_app(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(api_key) = store.read_key(binding.config_key)?.and_then(normalized_key) {
            return Ok(Some((api_key, CredentialSource::Config)));
        }
        Ok(None)
    })
    .await
    .map_err(|_| "读取模型凭证失败")?
}

pub async fn active_model_credential(
    app: &AppHandle,
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<(String, CredentialSource), String> {
    configured_model_credential(app, provider, scope)
        .await?
        .ok_or_else(|| format!("未配置 {} API Key", provider.display_name()))
}

async fn status(
    app: &AppHandle,
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<ModelCredentialStatus, String> {
    let (configured, source) = match configured_model_credential(app, provider, scope).await? {
        Some((_, source)) => (true, source),
        None => (false, CredentialSource::Missing),
    };
    Ok(ModelCredentialStatus {
        provider,
        scope,
        configured,
        source,
    })
}

#[tauri::command]
pub async fn model_credential_status(
    app: AppHandle,
    provider: ModelProvider,
    scope: Option<ProviderScope>,
) -> Result<ModelCredentialStatus, String> {
    status(&app, provider, scope.unwrap_or_default()).await
}

#[tauri::command]
pub async fn model_credential_set(
    app: AppHandle,
    input: SetModelCredentialInput,
) -> Result<ModelCredentialStatus, String> {
    let binding = credential_binding(input.provider, input.scope)?;
    let api_key = normalized_key(input.api_key).ok_or("模型 API Key 格式无效")?;
    let store = ModelCredentialStore::from_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.save_key(binding.config_key, api_key))
        .await
        .map_err(|_| "保存模型凭证失败")??;
    status(&app, input.provider, input.scope).await
}

#[tauri::command]
pub async fn model_credential_delete(
    app: AppHandle,
    provider: ModelProvider,
    scope: Option<ProviderScope>,
) -> Result<ModelCredentialStatus, String> {
    let scope = scope.unwrap_or_default();
    let binding = credential_binding(provider, scope)?;
    let store = ModelCredentialStore::from_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.delete_key(binding.config_key))
        .await
        .map_err(|_| "删除模型凭证失败")??;
    status(&app, provider, scope).await
}

#[cfg(test)]
mod tests {
    use super::{credential_binding, normalized_key};
    use crate::model_provider::{ModelProvider, ProviderScope};

    #[test]
    fn binds_only_supported_provider_scopes() {
        let deepseek = credential_binding(ModelProvider::Deepseek, ProviderScope::Default)
            .expect("bind legacy provider");
        assert_eq!(deepseek.config_key, "deepseek:default");
        let kimi =
            credential_binding(ModelProvider::Kimi, ProviderScope::Cn).expect("bind kimi cn");
        assert_eq!(kimi.config_key, "kimi:cn");
        assert!(credential_binding(ModelProvider::Kimi, ProviderScope::Default).is_err());
    }

    #[test]
    fn rejects_empty_or_oversized_credentials() {
        assert_eq!(normalized_key("  ".to_string()), None);
        assert_eq!(normalized_key("k".repeat(1_025)), None);
        assert_eq!(normalized_key(" key ".to_string()), Some("key".to_string()));
    }
}
