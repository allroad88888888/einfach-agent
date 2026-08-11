use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CONFIG_DIRECTORY: &str = ".web-agent";
const CONFIG_FILE: &str = "config.json";
const CONFIG_VERSION: u8 = 1;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebAgentConfig {
    #[serde(default = "config_version")]
    version: u8,
    #[serde(default)]
    model_credentials: BTreeMap<String, String>,
    #[serde(flatten, default)]
    other_settings: BTreeMap<String, serde_json::Value>,
}

impl Default for WebAgentConfig {
    fn default() -> Self {
        Self {
            version: config_version(),
            model_credentials: BTreeMap::new(),
            other_settings: BTreeMap::new(),
        }
    }
}

fn config_version() -> u8 {
    CONFIG_VERSION
}

/** Persists model credentials in the user's Web Agent configuration file. */
#[derive(Clone, Debug)]
pub struct ModelCredentialStore {
    path: PathBuf,
}

impl ModelCredentialStore {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "无法定位用户主目录".to_string())?;
        Ok(Self::from_home_directory(home))
    }

    fn from_home_directory(home: PathBuf) -> Self {
        Self {
            path: home.join(CONFIG_DIRECTORY).join(CONFIG_FILE),
        }
    }

    pub fn read_key(&self, key: &str) -> Result<Option<String>, String> {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| "模型配置文件锁定异常".to_string())?;
        Ok(self.read_config()?.model_credentials.get(key).cloned())
    }

    pub fn save_key(&self, key: &str, value: String) -> Result<(), String> {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| "模型配置文件锁定异常".to_string())?;
        let mut config = self.read_config()?;
        config.model_credentials.insert(key.to_string(), value);
        self.write_config(&config)
    }

    pub fn delete_key(&self, key: &str) -> Result<(), String> {
        let _guard = CONFIG_LOCK
            .lock()
            .map_err(|_| "模型配置文件锁定异常".to_string())?;
        let mut config = self.read_config()?;
        config.model_credentials.remove(key);
        self.write_config(&config)
    }

    fn read_config(&self) -> Result<WebAgentConfig, String> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(WebAgentConfig::default())
            }
            Err(_) => return Err("无法读取模型配置文件".to_string()),
        };
        let config: WebAgentConfig =
            serde_json::from_str(&contents).map_err(|_| "模型配置文件格式无效".to_string())?;
        if config.version != CONFIG_VERSION {
            return Err("模型配置文件版本不受支持".to_string());
        }
        Ok(config)
    }

    fn write_config(&self, config: &WebAgentConfig) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| "模型配置文件路径无效".to_string())?;
        fs::create_dir_all(directory).map_err(|_| "无法创建模型配置目录".to_string())?;
        restrict_directory(directory)?;
        let contents =
            serde_json::to_vec_pretty(config).map_err(|_| "无法编码模型配置文件".to_string())?;

        for attempt in 0..5 {
            let temporary = temporary_path(directory, attempt);
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建临时模型配置文件".to_string()),
            };
            let result = (|| {
                file.write_all(&contents)
                    .map_err(|_| "无法写入模型配置文件".to_string())?;
                file.sync_all()
                    .map_err(|_| "无法同步模型配置文件".to_string())?;
                restrict_file(&temporary)?;
                fs::rename(&temporary, &self.path)
                    .map_err(|_| "无法更新模型配置文件".to_string())?;
                sync_directory(directory)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            return result;
        }
        Err("无法创建临时模型配置文件".to_string())
    }
}

fn temporary_path(directory: &Path, attempt: u8) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    directory.join(format!(
        ".{CONFIG_FILE}-{}-{nanos}-{attempt}.tmp",
        std::process::id()
    ))
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护模型配置目录".to_string())
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法保护模型配置文件".to_string())
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "无法同步模型配置目录".to_string())
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), String> {
    Ok(())
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
    fn uses_the_hidden_web_agent_config_path() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        assert_eq!(store.path, home.0.join(".web-agent/config.json"));
    }

    #[test]
    fn preserves_other_config_values_when_saving_credentials() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        let directory = home.0.join(".web-agent");
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
    fn rejects_an_unsupported_config_version() {
        let home = test_home();
        let store = ModelCredentialStore::from_home_directory(home.0.clone());
        let directory = home.0.join(".web-agent");
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
        let metadata = fs::metadata(home.0.join(".web-agent/config.json")).expect("read metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
}
