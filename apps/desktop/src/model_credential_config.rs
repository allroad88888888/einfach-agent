use crate::web_agent_config_store::WebAgentConfigStore;
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::AppHandle;

const MODEL_CREDENTIAL_SECTION: &str = "modelCredentials";

type Credentials = BTreeMap<String, String>;

/** Persists model credentials in the user's Web Agent configuration file. */
#[derive(Clone, Debug)]
pub struct ModelCredentialStore {
    config: WebAgentConfigStore,
}

impl ModelCredentialStore {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        Ok(Self {
            config: WebAgentConfigStore::from_app(app)?,
        })
    }

    #[cfg(test)]
    fn from_home_directory(home: std::path::PathBuf) -> Self {
        Self {
            config: WebAgentConfigStore::from_home_directory(home),
        }
    }

    pub fn read_key(&self, key: &str) -> Result<Option<String>, String> {
        let section = self.config.read_section(MODEL_CREDENTIAL_SECTION)?;
        Ok(decode_credentials(section)?.get(key).cloned())
    }

    pub fn save_key(&self, key: &str, value: String) -> Result<(), String> {
        self.update_credentials(|credentials| {
            credentials.insert(key.to_string(), value);
        })
    }

    pub fn delete_key(&self, key: &str) -> Result<(), String> {
        self.update_credentials(|credentials| {
            credentials.remove(key);
        })
    }

    fn update_credentials<Change>(&self, change: Change) -> Result<(), String>
    where
        Change: FnOnce(&mut Credentials),
    {
        self.config
            .update_section(MODEL_CREDENTIAL_SECTION, |section| {
                let mut credentials = decode_credentials(section)?;
                change(&mut credentials);
                encode_credentials(credentials).map(Some)
            })
    }
}

fn decode_credentials(section: Option<Value>) -> Result<Credentials, String> {
    let Some(section) = section else {
        return Ok(Credentials::new());
    };
    serde_json::from_value(section).map_err(|_| "模型配置文件格式无效".to_string())
}

fn encode_credentials(credentials: Credentials) -> Result<Value, String> {
    serde_json::to_value(credentials).map_err(|_| "无法编码模型配置文件".to_string())
}

#[cfg(test)]
mod tests {
    use super::ModelCredentialStore;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestHome(PathBuf);

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_home() -> TestHome {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        TestHome(std::env::temp_dir().join(format!(
            "web-agent-model-credential-test-{}-{nanos}",
            std::process::id(),
        )))
    }

    #[test]
    fn preserves_other_config_values_when_saving_credentials() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        let directory = home.0.join(".webAgent");
        fs::create_dir_all(&directory).expect("create config directory");
        fs::write(
            directory.join("config.json"),
            r#"{"version":1,"otherSetting":{"enabled":true}}"#,
        )
        .expect("write config fixture");

        store
            .save_key("deepseek:default", "test-key".to_string())
            .expect("save credential");

        let config: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(directory.join("config.json")).expect("read config"),
        )
        .expect("parse config");
        assert_eq!(config["otherSetting"]["enabled"], true);
        assert_eq!(config["modelCredentials"]["deepseek:default"], "test-key");
        assert_eq!(
            store.read_key("deepseek:default").expect("read credential"),
            Some("test-key".to_string())
        );
    }

    #[test]
    fn deletes_a_credential_without_dropping_the_others() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        store
            .save_key("deepseek:default", "one".to_string())
            .expect("save first credential");
        store
            .save_key("kimi:cn", "two".to_string())
            .expect("save second credential");

        store
            .delete_key("deepseek:default")
            .expect("delete credential");

        assert_eq!(store.read_key("deepseek:default"), Ok(None));
        assert_eq!(store.read_key("kimi:cn"), Ok(Some("two".to_string())));
    }

    #[test]
    fn rejects_a_malformed_credential_section() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        let directory = home.0.join(".webAgent");
        fs::create_dir_all(&directory).expect("create config directory");
        fs::write(
            directory.join("config.json"),
            r#"{"version":1,"modelCredentials":"oops"}"#,
        )
        .expect("write config fixture");

        assert_eq!(
            store.read_key("deepseek:default"),
            Err("模型配置文件格式无效".to_string())
        );
    }

    #[test]
    fn rejects_an_unsupported_config_version() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        let directory = home.0.join(".webAgent");
        fs::create_dir_all(&directory).expect("create config directory");
        fs::write(directory.join("config.json"), r#"{"version":2}"#).expect("write config fixture");

        assert_eq!(
            store.read_key("deepseek:default"),
            Err("模型配置文件版本不受支持".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn restricts_new_config_files_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        store
            .save_key("deepseek:default", "test-key".to_string())
            .expect("save credential");
        let metadata = fs::metadata(home.0.join(".webAgent/config.json")).expect("read metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
}
