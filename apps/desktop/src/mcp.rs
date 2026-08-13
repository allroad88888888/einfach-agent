//! MCP stdio 集成的模块装配与 Tauri 命令入口。

#[path = "mcp_lifecycle.rs"]
mod lifecycle;
#[path = "mcp_limits.rs"]
mod limits;
#[path = "mcp_manager.rs"]
mod manager;
#[path = "mcp_process.rs"]
mod process;
#[path = "mcp_protocol.rs"]
mod protocol;
#[path = "mcp_session.rs"]
mod session;
#[path = "mcp_session_spawn.rs"]
mod session_spawn;
#[path = "mcp_support.rs"]
mod support;
#[path = "mcp_types.rs"]
mod types;
#[path = "mcp_validation.rs"]
mod validation;

pub use self::manager::McpManager;
pub use self::types::*;

use self::lifecycle::McpLifecycleEventSink;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn mcp_connect(
    app: AppHandle,
    state: State<'_, McpManager>,
    input: McpConnectInput,
) -> Result<McpConnectResult, McpCommandError> {
    let manager = state.inner().clone();
    let event_sink = McpLifecycleEventSink::from_app(app);
    tauri::async_runtime::spawn_blocking(move || manager.connect_with_events(input, event_sink))
        .await
        .map_err(|error| McpCommandError::worker(format!("MCP connect worker failed: {error}")))?
}

#[tauri::command]
pub async fn mcp_list_tools(
    state: State<'_, McpManager>,
    input: McpListToolsInput,
) -> Result<McpListToolsResult, McpCommandError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.list_tools(input))
        .await
        .map_err(|error| McpCommandError::worker(format!("MCP tools worker failed: {error}")))?
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpManager>,
    input: McpCallToolInput,
) -> Result<McpCallToolResult, McpCommandError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.call_tool(input))
        .await
        .map_err(|error| McpCommandError::worker(format!("MCP tool worker failed: {error}")))?
}

#[tauri::command]
pub async fn mcp_disconnect(
    state: State<'_, McpManager>,
    input: McpDisconnectInput,
) -> Result<McpDisconnectResult, McpCommandError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.disconnect(input))
        .await
        .map_err(|error| {
            McpCommandError::worker(format!("MCP disconnect worker failed: {error}"))
        })?
}
