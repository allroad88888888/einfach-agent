use crate::model_provider::ModelProvider;
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
    pub configured: bool,
    pub source: CredentialSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModelCredentialInput {
    pub provider: ModelProvider,
    pub api_key: String,
}

fn entry(provider: ModelProvider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, provider.credential_account())
        .map_err(|_| "无法访问系统钥匙串".to_string())
}

fn normalized_key(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty() && value.len() <= MAX_API_KEY_LENGTH).then_some(value)
}

fn read_keychain_key(provider: ModelProvider) -> Option<String> {
    entry(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(normalized_key)
}

fn read_environment_key(provider: ModelProvider) -> Option<String> {
    std::env::var(provider.environment_variable())
        .ok()
        .and_then(normalized_key)
}

pub async fn active_model_credential(
    provider: ModelProvider,
) -> Result<(String, CredentialSource), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(api_key) = read_keychain_key(provider) {
            return Ok((api_key, CredentialSource::Keychain));
        }
        if let Some(api_key) = read_environment_key(provider) {
            return Ok((api_key, CredentialSource::Environment));
        }
        Err(format!("未配置 {} API Key", provider.display_name()))
    })
    .await
    .map_err(|_| "读取模型凭证失败")?
}

async fn status(provider: ModelProvider) -> ModelCredentialStatus {
    match active_model_credential(provider).await {
        Ok((_, source)) => ModelCredentialStatus {
            provider,
            configured: true,
            source,
        },
        Err(_) => ModelCredentialStatus {
            provider,
            configured: false,
            source: CredentialSource::Missing,
        },
    }
}

#[tauri::command]
pub async fn model_credential_status(provider: ModelProvider) -> ModelCredentialStatus {
    status(provider).await
}

#[tauri::command]
pub async fn model_credential_set(
    input: SetModelCredentialInput,
) -> Result<ModelCredentialStatus, String> {
    let api_key = normalized_key(input.api_key).ok_or("模型 API Key 格式无效")?;
    let provider = input.provider;
    tauri::async_runtime::spawn_blocking(move || {
        entry(provider)?
            .set_password(&api_key)
            .map_err(|_| "无法保存到系统钥匙串".to_string())
    })
    .await
    .map_err(|_| "保存模型凭证失败")??;
    Ok(status(provider).await)
}

#[tauri::command]
pub async fn model_credential_delete(
    provider: ModelProvider,
) -> Result<ModelCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        entry(provider)?
            .delete_credential()
            .map_err(|_| "无法从系统钥匙串删除凭证".to_string())
    })
    .await
    .map_err(|_| "删除模型凭证失败")??;
    Ok(status(provider).await)
}

#[cfg(test)]
mod tests {
    use super::normalized_key;

    #[test]
    fn rejects_empty_or_oversized_credentials() {
        assert_eq!(normalized_key("  ".to_string()), None);
        assert_eq!(normalized_key("k".repeat(1_025)), None);
        assert_eq!(normalized_key(" key ".to_string()), Some("key".to_string()));
    }
}
