use crate::web_agent_config_store::WebAgentConfigStore;
use serde_json::{Map, Value};
use tauri::AppHandle;

const MCP_SECTION: &str = "mcp";

/** 读写用户配置文件中的 `mcp` 段：MCP 服务清单与工具清单缓存等前端状态。 */
#[derive(Clone, Debug)]
pub struct McpConfigStore {
    config: WebAgentConfigStore,
}

impl McpConfigStore {
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

    /** 读取整个 `mcp` 段；配置文件或该段不存在时返回空对象。 */
    pub fn read(&self) -> Result<Value, String> {
        let section = self.config.read_section(MCP_SECTION)?;
        Ok(section.unwrap_or_else(|| Value::Object(Map::new())))
    }

    /**
     * 把 `patch` 的顶层键合并进现有 `mcp` 段：读取当前值、按键合并、写回在同一次
     * 加锁内完成，避免并发写互相覆盖。`patch` 中值为 `null` 的键会被删除，配置
     * 文件里其余顶层段保持不变。返回合并后的 `mcp` 段。
     */
    pub fn merge(&self, patch: Value) -> Result<Value, String> {
        let Value::Object(patch) = patch else {
            return Err("mcp 配置段补丁必须是 JSON 对象".to_string());
        };
        self.config.update_section(MCP_SECTION, |current| {
            let mut section = match current {
                Some(Value::Object(map)) => map,
                Some(_) => return Err("mcp 配置段格式无效".to_string()),
                None => Map::new(),
            };
            for (key, value) in patch {
                if value.is_null() {
                    section.remove(&key);
                } else {
                    section.insert(key, value);
                }
            }
            Ok(Some(Value::Object(section)))
        })?;
        self.read()
    }
}

/** 读取整个 `mcp` 配置段，供前端展示已缓存的 MCP 服务清单与工具清单。 */
#[tauri::command]
pub async fn mcp_config_read(app: AppHandle) -> Result<Value, String> {
    let store = McpConfigStore::from_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.read())
        .await
        .map_err(|_| "读取 MCP 配置失败".to_string())?
}

/** 把 `patch` 合并进 `mcp` 配置段并返回合并后的结果，值为 `null` 的键会被删除。 */
#[tauri::command]
pub async fn mcp_config_write(app: AppHandle, patch: Value) -> Result<Value, String> {
    let store = McpConfigStore::from_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.merge(patch))
        .await
        .map_err(|_| "写入 MCP 配置失败".to_string())?
}

#[cfg(test)]
#[path = "mcp_config_tests.rs"]
mod tests;
