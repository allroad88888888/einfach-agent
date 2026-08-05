use crate::model_provider::{ModelProvider, ProviderScope};
use serde::{Deserialize, Serialize};

const CREDENTIAL_SERVICE: &str = "com.webagent.app";
const MAX_API_KEY_LENGTH: usize = 1_024;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Keychain,
    Environment,
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
    account: &'static str,
    environment_variable: &'static str,
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
            account: "model-api-key:deepseek",
            environment_variable: "DEEPSEEK_API_KEY",
        }),
        (Glm, Default) => Ok(CredentialBinding {
            account: "model-api-key:glm",
            environment_variable: "GLM_API_KEY",
        }),
        (Kimi, Cn) => Ok(CredentialBinding {
            account: "model-api-key:kimi:cn",
            environment_variable: "KIMI_API_KEY",
        }),
        _ => Err("模型凭证作用域未获允许".to_string()),
    }
}

fn entry(binding: CredentialBinding) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, binding.account)
        .map_err(|_| "无法访问系统钥匙串".to_string())
}

fn normalized_key(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty() && value.len() <= MAX_API_KEY_LENGTH).then_some(value)
}

fn read_keychain_key(binding: CredentialBinding) -> Option<String> {
    entry(binding)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(normalized_key)
}

fn read_environment_key(binding: CredentialBinding) -> Option<String> {
    std::env::var(binding.environment_variable)
        .ok()
        .and_then(normalized_key)
}

pub async fn active_model_credential(
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<(String, CredentialSource), String> {
    let binding = credential_binding(provider, scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(api_key) = read_keychain_key(binding) {
            return Ok((api_key, CredentialSource::Keychain));
        }
        if let Some(api_key) = read_environment_key(binding) {
            return Ok((api_key, CredentialSource::Environment));
        }
        Err(format!("未配置 {} API Key", provider.display_name()))
    })
    .await
    .map_err(|_| "读取模型凭证失败")?
}

async fn status(
    provider: ModelProvider,
    scope: ProviderScope,
) -> Result<ModelCredentialStatus, String> {
    credential_binding(provider, scope)?;
    let (configured, source) = match active_model_credential(provider, scope).await {
        Ok((_, source)) => (true, source),
        Err(_) => (false, CredentialSource::Missing),
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
    provider: ModelProvider,
    scope: Option<ProviderScope>,
) -> Result<ModelCredentialStatus, String> {
    status(provider, scope.unwrap_or_default()).await
}

#[tauri::command]
pub async fn model_credential_set(
    input: SetModelCredentialInput,
) -> Result<ModelCredentialStatus, String> {
    let binding = credential_binding(input.provider, input.scope)?;
    let api_key = normalized_key(input.api_key).ok_or("模型 API Key 格式无效")?;
    tauri::async_runtime::spawn_blocking(move || {
        entry(binding)?
            .set_password(&api_key)
            .map_err(|_| "无法保存到系统钥匙串".to_string())
    })
    .await
    .map_err(|_| "保存模型凭证失败")??;
    status(input.provider, input.scope).await
}

#[tauri::command]
pub async fn model_credential_delete(
    provider: ModelProvider,
    scope: Option<ProviderScope>,
) -> Result<ModelCredentialStatus, String> {
    let scope = scope.unwrap_or_default();
    let binding = credential_binding(provider, scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        entry(binding)?
            .delete_credential()
            .map_err(|_| "无法从系统钥匙串删除凭证".to_string())
    })
    .await
    .map_err(|_| "删除模型凭证失败")??;
    status(provider, scope).await
}

#[cfg(test)]
mod tests {
    use super::{credential_binding, normalized_key};
    use crate::model_provider::{ModelProvider, ProviderScope};

    #[test]
    fn binds_only_supported_provider_scopes() {
        let deepseek = credential_binding(ModelProvider::Deepseek, ProviderScope::Default)
            .expect("bind legacy provider");
        assert_eq!(deepseek.account, "model-api-key:deepseek");
        let kimi =
            credential_binding(ModelProvider::Kimi, ProviderScope::Cn).expect("bind kimi cn");
        assert_eq!(kimi.environment_variable, "KIMI_API_KEY");
        assert!(credential_binding(ModelProvider::Kimi, ProviderScope::Default).is_err());
    }

    #[test]
    fn rejects_empty_or_oversized_credentials() {
        assert_eq!(normalized_key("  ".to_string()), None);
        assert_eq!(normalized_key("k".repeat(1_025)), None);
        assert_eq!(normalized_key(" key ".to_string()), Some("key".to_string()));
    }
}
