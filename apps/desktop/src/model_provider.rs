use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    Deepseek,
    Glm,
}

impl ModelProvider {
    pub const fn credential_account(self) -> &'static str {
        match self {
            Self::Deepseek => "model-api-key:deepseek",
            Self::Glm => "model-api-key:glm",
        }
    }

    pub const fn environment_variable(self) -> &'static str {
        match self {
            Self::Deepseek => "DEEPSEEK_API_KEY",
            Self::Glm => "GLM_API_KEY",
        }
    }

    pub const fn chat_completions_url(self) -> &'static str {
        match self {
            Self::Deepseek => "https://api.deepseek.com/chat/completions",
            Self::Glm => "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        }
    }

    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Deepseek => "DeepSeek",
            Self::Glm => "GLM",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ModelProvider;

    #[test]
    fn providers_only_map_to_fixed_chat_endpoints() {
        assert_eq!(
            ModelProvider::Deepseek.chat_completions_url(),
            "https://api.deepseek.com/chat/completions",
        );
        assert_eq!(
            ModelProvider::Glm.chat_completions_url(),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        );
    }
}
