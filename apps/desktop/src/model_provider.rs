use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    Deepseek,
    Glm,
    Kimi,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderScope {
    #[default]
    Default,
    Cn,
}

impl ModelProvider {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Deepseek => "DeepSeek",
            Self::Glm => "GLM",
            Self::Kimi => "Kimi",
        }
    }

    pub const fn accepts_scope(self, scope: ProviderScope) -> bool {
        matches!(
            (self, scope),
            (Self::Deepseek, ProviderScope::Default)
                | (Self::Glm, ProviderScope::Default)
                | (Self::Kimi, ProviderScope::Cn)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{ModelProvider, ProviderScope};

    #[test]
    fn only_fixed_provider_scope_pairs_are_allowed() {
        assert!(ModelProvider::Deepseek.accepts_scope(ProviderScope::Default));
        assert!(ModelProvider::Glm.accepts_scope(ProviderScope::Default));
        assert!(ModelProvider::Kimi.accepts_scope(ProviderScope::Cn));
        assert!(!ModelProvider::Kimi.accepts_scope(ProviderScope::Default));
        assert!(!ModelProvider::Deepseek.accepts_scope(ProviderScope::Cn));
    }
}
