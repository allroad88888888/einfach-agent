use crate::model_provider::{ModelProvider, ProviderScope};
use serde::{Deserialize, Serialize};

const CHAT_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;
const FILE_RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const DELETE_RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum ProviderMethod {
    #[serde(rename = "POST")]
    Post,
    #[serde(rename = "DELETE")]
    Delete,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTarget {
    pub provider: ModelProvider,
    #[serde(default)]
    pub scope: ProviderScope,
    pub method: ProviderMethod,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderBodyKind {
    None,
    Json,
    Multipart,
}

pub struct ResolvedProviderTarget {
    pub provider: ModelProvider,
    pub scope: ProviderScope,
    pub method: ProviderMethod,
    pub url: String,
    pub body_kind: ProviderBodyKind,
    pub max_response_bytes: usize,
}

fn valid_resource_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_file_delete_path(path: &str) -> bool {
    path.strip_prefix("/files/").is_some_and(valid_resource_id)
}

fn resolved(
    target: &ProviderTarget,
    origin: &str,
    body_kind: ProviderBodyKind,
    max_response_bytes: usize,
) -> ResolvedProviderTarget {
    ResolvedProviderTarget {
        provider: target.provider,
        scope: target.scope,
        method: target.method,
        url: format!("{origin}{}", target.path),
        body_kind,
        max_response_bytes,
    }
}

/** Applies the native host's closed origin plus method/path transport policy. */
pub fn resolve_provider_target(target: &ProviderTarget) -> Result<ResolvedProviderTarget, String> {
    use ModelProvider::{Deepseek, Glm, Kimi};
    use ProviderBodyKind::{Json, Multipart, None as NoBody};
    use ProviderMethod::{Delete, Post};
    use ProviderScope::{Cn, Default};

    match (
        target.provider,
        target.scope,
        target.method,
        target.path.as_str(),
    ) {
        (Deepseek, Default, Post, "/chat/completions") => Ok(resolved(
            target,
            "https://api.deepseek.com",
            Json,
            CHAT_RESPONSE_LIMIT,
        )),
        (Glm, Default, Post, "/chat/completions") => Ok(resolved(
            target,
            "https://open.bigmodel.cn/api/paas/v4",
            Json,
            CHAT_RESPONSE_LIMIT,
        )),
        (Kimi, Cn, Post, "/chat/completions") => Ok(resolved(
            target,
            "https://api.moonshot.cn/v1",
            Json,
            CHAT_RESPONSE_LIMIT,
        )),
        (Kimi, Cn, Post, "/files") => Ok(resolved(
            target,
            "https://api.moonshot.cn/v1",
            Multipart,
            FILE_RESPONSE_LIMIT,
        )),
        (Kimi, Cn, Delete, path) if valid_file_delete_path(path) => Ok(resolved(
            target,
            "https://api.moonshot.cn/v1",
            NoBody,
            DELETE_RESPONSE_LIMIT,
        )),
        _ => Err("模型请求目标未获允许".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_provider_target, ProviderTarget};

    fn target(source: &str) -> ProviderTarget {
        serde_json::from_str(source).expect("deserialize provider target")
    }

    #[test]
    fn resolves_only_fixed_provider_scope_method_path_combinations() {
        let upload = target(r#"{"provider":"kimi","scope":"cn","method":"POST","path":"/files"}"#);
        assert_eq!(
            resolve_provider_target(&upload)
                .expect("resolve upload")
                .url,
            "https://api.moonshot.cn/v1/files"
        );
        let global =
            target(r#"{"provider":"kimi","scope":"default","method":"POST","path":"/files"}"#);
        assert!(resolve_provider_target(&global).is_err());
    }

    #[test]
    fn accepts_only_safe_delete_paths() {
        let valid = target(
            r#"{"provider":"kimi","scope":"cn","method":"DELETE","path":"/files/file_123.A-b"}"#,
        );
        assert!(resolve_provider_target(&valid).is_ok());
        for path in ["/files/", "/files/../key", "/files/key?query", "/files/x/y"] {
            let candidate = target(&format!(
                r#"{{"provider":"kimi","scope":"cn","method":"DELETE","path":"{path}"}}"#
            ));
            assert!(resolve_provider_target(&candidate).is_err());
        }
    }

    #[test]
    fn rejects_unknown_target_fields() {
        assert!(serde_json::from_str::<ProviderTarget>(
            r#"{"provider":"kimi","scope":"cn","method":"POST","path":"/files","url":"https://evil.test"}"#,
        )
        .is_err());
    }
}
