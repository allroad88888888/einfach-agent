use crate::web_agent_config_write::write_restricted_atomically;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const CONFIG_DIRECTORY: &str = ".web-agent";
const CONFIG_FILE: &str = "config.json";
const CONFIG_DIRECTORY_ENV: &str = "WEB_AGENT_CONFIG_DIR";
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
        Self::from_home_directory_with_config_directory(
            home,
            std::env::var_os(CONFIG_DIRECTORY_ENV),
        )
    }

    #[allow(dead_code)]
    pub fn from_home_directory(home: PathBuf) -> Self {
        Self::from_home_directory_with_config_directory(home, None)
            .expect("默认模型配置目录必须有效")
    }

    fn from_home_directory_with_config_directory(
        home: PathBuf,
        config_directory_override: Option<OsString>,
    ) -> Result<Self, String> {
        let config_directory = match config_directory_override {
            None => home.join(CONFIG_DIRECTORY),
            Some(directory) if directory.is_empty() => {
                return Err("WEB_AGENT_CONFIG_DIR 不能为空".to_string())
            }
            Some(directory) => {
                let path = PathBuf::from(directory);
                if !path.is_absolute() {
                    return Err("WEB_AGENT_CONFIG_DIR 必须是绝对路径".to_string());
                }
                validate_existing_config_directory(&path)?;
                path
            }
        };
        Ok(Self {
            path: config_directory.join(CONFIG_FILE),
        })
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

fn validate_existing_config_directory(path: &PathBuf) -> Result<(), String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取 WEB_AGENT_CONFIG_DIR".to_string()),
    };
    if !metadata.is_dir() {
        return Err("WEB_AGENT_CONFIG_DIR 必须是目录".to_string());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err("WEB_AGENT_CONFIG_DIR 目录权限必须为 0700".to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "web_agent_config_store_tests.rs"]
mod tests;
