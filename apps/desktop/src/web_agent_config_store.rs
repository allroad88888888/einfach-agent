use crate::web_agent_config_write::write_restricted_atomically;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use tauri::{AppHandle, Manager};

const CONFIG_DIRECTORY: &str = ".web-agent";
const CONFIG_FILE: &str = "config.json";
const CONFIG_VERSION: u8 = 1;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/** `~/.web-agent/config.json` 的顶层形状：一个版本号加任意多个具名配置段。 */
#[derive(Debug, Deserialize, Serialize)]
struct WebAgentConfig {
    #[serde(default = "config_version")]
    version: u8,
    #[serde(flatten, default)]
    sections: BTreeMap<String, Value>,
}

impl Default for WebAgentConfig {
    fn default() -> Self {
        Self {
            version: config_version(),
            sections: BTreeMap::new(),
        }
    }
}

fn config_version() -> u8 {
    CONFIG_VERSION
}

fn lock_config() -> Result<MutexGuard<'static, ()>, String> {
    CONFIG_LOCK
        .lock()
        .map_err(|_| "模型配置文件锁定异常".to_string())
}

/** 按配置段读写用户的 Web Agent 配置文件，未识别的顶层键原样保留。 */
#[derive(Clone, Debug)]
pub struct WebAgentConfigStore {
    path: PathBuf,
}

impl WebAgentConfigStore {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "无法定位用户主目录".to_string())?;
        Ok(Self::from_home_directory(home))
    }

    pub fn from_home_directory(home: PathBuf) -> Self {
        Self {
            path: home.join(CONFIG_DIRECTORY).join(CONFIG_FILE),
        }
    }

    /** 读取一个配置段；文件或配置段不存在时返回 `None`。 */
    pub fn read_section(&self, section: &str) -> Result<Option<Value>, String> {
        let _guard = lock_config()?;
        Ok(self.read_config()?.sections.get(section).cloned())
    }

    /** 覆盖写入一个配置段，其余顶层键保持不变。 */
    #[allow(dead_code)]
    pub fn write_section(&self, section: &str, value: Value) -> Result<(), String> {
        self.update_section(section, |_| Ok(Some(value)))
    }

    /** 删除一个配置段，其余顶层键保持不变。 */
    #[allow(dead_code)]
    pub fn remove_section(&self, section: &str) -> Result<(), String> {
        self.update_section(section, |_| Ok(None))
    }

    /**
     * 在同一次加锁内完成配置段的读—改—写。回调收到当前值（缺失为 `None`），
     * 返回 `Some` 写回、返回 `None` 删除该段。
     */
    pub fn update_section<Update>(&self, section: &str, update: Update) -> Result<(), String>
    where
        Update: FnOnce(Option<Value>) -> Result<Option<Value>, String>,
    {
        let _guard = lock_config()?;
        let mut config = self.read_config()?;
        match update(config.sections.get(section).cloned())? {
            Some(value) => {
                config.sections.insert(section.to_string(), value);
            }
            None => {
                config.sections.remove(section);
            }
        }
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
        let contents =
            serde_json::to_vec_pretty(config).map_err(|_| "无法编码模型配置文件".to_string())?;
        write_restricted_atomically(&self.path, &contents)
    }
}

#[cfg(test)]
mod tests {
    use super::WebAgentConfigStore;
    use serde_json::json;
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
            "web-agent-config-store-test-{}-{nanos}",
            std::process::id(),
        )))
    }

    fn stored_config(home: &TestHome) -> serde_json::Value {
        serde_json::from_str(
            &fs::read_to_string(home.0.join(".web-agent/config.json")).expect("read config"),
        )
        .expect("parse config")
    }

    fn write_fixture(home: &TestHome, contents: &str) {
        let directory = home.0.join(".web-agent");
        fs::create_dir_all(&directory).expect("create config directory");
        fs::write(directory.join("config.json"), contents).expect("write config fixture");
    }

    #[test]
    fn uses_the_hidden_web_agent_config_path() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        assert_eq!(store.path, home.0.join(".web-agent/config.json"));
    }

    #[test]
    fn reads_a_missing_section_as_none() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        assert_eq!(store.read_section("mcp"), Ok(None));

        write_fixture(&home, r#"{"version":1,"otherSetting":{"enabled":true}}"#);
        assert_eq!(store.read_section("mcp"), Ok(None));
    }

    #[test]
    fn writing_a_section_keeps_other_top_level_keys() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        write_fixture(
            &home,
            r#"{"version":1,"modelCredentials":{"deepseek:default":"test-key"},"otherSetting":{"enabled":true}}"#,
        );

        store
            .write_section("mcp", json!({ "servers": ["local"] }))
            .expect("write section");

        let config = stored_config(&home);
        assert_eq!(config["version"], 1);
        assert_eq!(config["mcp"]["servers"][0], "local");
        assert_eq!(config["modelCredentials"]["deepseek:default"], "test-key");
        assert_eq!(config["otherSetting"]["enabled"], true);
        assert_eq!(
            store.read_section("mcp"),
            Ok(Some(json!({ "servers": ["local"] })))
        );
    }

    #[test]
    fn updating_a_section_sees_the_current_value_and_can_remove_it() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        write_fixture(&home, r#"{"version":1,"mcp":{"servers":[]}}"#);

        store
            .update_section("mcp", |current| {
                assert_eq!(current, Some(json!({ "servers": [] })));
                Ok(Some(json!({ "servers": ["local"] })))
            })
            .expect("update section");
        assert_eq!(stored_config(&home)["mcp"]["servers"][0], "local");

        store.remove_section("mcp").expect("remove section");
        assert_eq!(store.read_section("mcp"), Ok(None));
        assert_eq!(stored_config(&home)["version"], 1);
    }

    #[test]
    fn keeps_the_file_untouched_when_an_update_fails() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        write_fixture(&home, r#"{"version":1,"mcp":{"servers":[]}}"#);

        assert_eq!(
            store.update_section("mcp", |_| Err("拒绝写入".to_string())),
            Err("拒绝写入".to_string())
        );
        assert_eq!(stored_config(&home)["mcp"], json!({ "servers": [] }));
    }

    #[test]
    fn rejects_a_corrupted_config_file() {
        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        write_fixture(&home, "{ not json");

        assert_eq!(
            store.read_section("mcp"),
            Err("模型配置文件格式无效".to_string())
        );
        assert_eq!(
            store.write_section("mcp", json!({})),
            Err("模型配置文件格式无效".to_string())
        );
        assert_eq!(
            fs::read_to_string(home.0.join(".web-agent/config.json")).expect("read config"),
            "{ not json"
        );
    }

    #[cfg(unix)]
    #[test]
    fn restricts_the_config_directory_and_file_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let home = test_home();
        let store = WebAgentConfigStore::from_home_directory(home.0.clone());
        store
            .write_section("mcp", json!({ "servers": [] }))
            .expect("write section");

        let directory = fs::metadata(home.0.join(".web-agent")).expect("read directory metadata");
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
        let file = fs::metadata(home.0.join(".web-agent/config.json")).expect("read metadata");
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
    }
}
