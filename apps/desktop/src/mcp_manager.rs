//! MCP 会话注册表与 connect / list / call / disconnect 四个操作。

use serde::Deserialize;
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use super::lifecycle::McpLifecycleEventSink;
use super::limits::{
    DEFAULT_DISCONNECT_GRACE_MS, DEFAULT_MAX_TOOL_PAGES, DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_DISCONNECT_GRACE_MS, MAX_SESSION_TOKENS, MAX_TOOL_PAGES, MAX_TOTAL_TOOLS,
};
use super::session::McpSession;
use super::support::{duration_millis, lock_recover};
use super::types::{
    McpCallToolInput, McpCallToolResult, McpCommandError, McpConnectInput, McpConnectResult,
    McpDisconnectInput, McpDisconnectResult, McpImplementationInfo, McpListToolsInput,
    McpListToolsResult, McpTool, McpToolCallPayload,
};
use super::validation::{
    normalize_client_info, normalize_identifier, normalize_protocol_version, normalize_timeout,
    validate_command,
};

#[derive(Clone)]
pub struct McpManager {
    inner: Arc<McpManagerInner>,
}

impl Default for McpManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(McpManagerInner::default()),
        }
    }
}

#[derive(Default)]
struct McpManagerInner {
    registry: Mutex<McpRegistry>,
}

#[derive(Default)]
struct McpRegistry {
    sessions: HashMap<String, Arc<McpSession>>,
    connecting: HashSet<String>,
    closing: HashSet<String>,
    used_session_tokens: HashSet<String>,
}

impl Drop for McpManagerInner {
    fn drop(&mut self) {
        let sessions = {
            let mut registry = lock_recover(&self.registry);
            registry.connecting.clear();
            registry.closing.clear();
            registry.used_session_tokens.clear();
            registry
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };

        for session in sessions {
            let _ = session.close(Duration::from_millis(DEFAULT_DISCONNECT_GRACE_MS));
        }
    }
}

impl McpManager {
    #[cfg(test)]
    fn connect(&self, input: McpConnectInput) -> Result<McpConnectResult, McpCommandError> {
        self.connect_with_events(input, McpLifecycleEventSink::default())
    }

    pub(super) fn connect_with_events(
        &self,
        input: McpConnectInput,
        event_sink: McpLifecycleEventSink,
    ) -> Result<McpConnectResult, McpCommandError> {
        let server_id = normalize_identifier(&input.server_id, "serverId")?;
        let session_token = normalize_identifier(&input.session_token, "sessionToken")
            .map_err(|error| error.for_server(&server_id))?;
        validate_command(&input.command, &server_id)?;
        let default_timeout = normalize_timeout(
            input.request_timeout_ms,
            DEFAULT_REQUEST_TIMEOUT_MS,
            "requestTimeoutMs",
            &server_id,
        )?;
        let protocol_version = normalize_protocol_version(input.protocol_version.as_deref())
            .map_err(|error| error.for_server(&server_id))?;
        let client_info = normalize_client_info(input.client_info.clone(), &server_id)?;

        {
            let mut registry = lock_recover(&self.inner.registry);
            if registry.sessions.contains_key(&server_id)
                || registry.connecting.contains(&server_id)
                || registry.closing.contains(&server_id)
            {
                return Err(McpCommandError::new(
                    "already_connected",
                    format!(
                        "MCP server `{server_id}` is already connected, connecting, or disconnecting"
                    ),
                )
                .for_server(&server_id));
            }
            if registry.used_session_tokens.contains(&session_token) {
                return Err(McpCommandError::new(
                    "stale_session",
                    "MCP sessionToken has already been used; reconnect with a fresh token",
                )
                .for_server(&server_id));
            }
            if registry.used_session_tokens.len() >= MAX_SESSION_TOKENS {
                return Err(McpCommandError::new(
                    "session_limit",
                    format!(
                        "MCP session token safety limit ({MAX_SESSION_TOKENS}) reached; restart the application"
                    ),
                )
                .for_server(&server_id));
            }
            registry.used_session_tokens.insert(session_token.clone());
            registry.connecting.insert(server_id.clone());
        }

        let connected = self.connect_reserved(
            &server_id,
            &input,
            default_timeout,
            protocol_version,
            client_info,
            session_token,
            event_sink,
        );

        let mut registry = lock_recover(&self.inner.registry);
        registry.connecting.remove(&server_id);
        match connected {
            Ok((session, result)) => {
                registry.sessions.insert(server_id, session);
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }

    fn connect_reserved(
        &self,
        server_id: &str,
        input: &McpConnectInput,
        default_timeout: Duration,
        protocol_version: String,
        client_info: McpImplementationInfo,
        session_token: String,
        event_sink: McpLifecycleEventSink,
    ) -> Result<(Arc<McpSession>, McpConnectResult), McpCommandError> {
        let session = McpSession::spawn(
            server_id,
            &session_token,
            input,
            default_timeout,
            event_sink,
        )?;
        let initialized = session.initialize(&protocol_version, &client_info);

        match initialized {
            Ok(result) => Ok((session, result)),
            Err(error) => {
                let _ = session.close(Duration::from_millis(DEFAULT_DISCONNECT_GRACE_MS));
                Err(error)
            }
        }
    }

    pub(super) fn list_tools(
        &self,
        input: McpListToolsInput,
    ) -> Result<McpListToolsResult, McpCommandError> {
        let server_id = normalize_identifier(&input.server_id, "serverId")?;
        let session_token = normalize_identifier(&input.session_token, "sessionToken")
            .map_err(|error| error.for_server(&server_id))?;
        let session = self.session(&server_id, &session_token)?;
        let timeout = session.resolve_timeout(input.timeout_ms, "timeoutMs")?;
        let all_pages = input.all_pages.unwrap_or(true);
        let max_pages = match input.max_pages {
            Some(0) => {
                return Err(McpCommandError::new(
                    "invalid_input",
                    "maxPages must be greater than zero",
                )
                .for_server(&server_id))
            }
            Some(value) => value.min(MAX_TOOL_PAGES),
            None => DEFAULT_MAX_TOOL_PAGES,
        };

        let started = Instant::now();
        let mut cursor = input.cursor;
        let mut seen_cursors = HashSet::new();
        if let Some(value) = cursor.as_ref() {
            seen_cursors.insert(value.clone());
        }
        let mut tools = Vec::new();
        let mut pages_fetched = 0usize;

        loop {
            let remaining = timeout.checked_sub(started.elapsed()).ok_or_else(|| {
                McpCommandError::new(
                    "timeout",
                    format!(
                        "MCP tools/list timed out after {} ms",
                        duration_millis(timeout)
                    ),
                )
                .for_server(&server_id)
            })?;
            let mut params = Map::new();
            if let Some(value) = cursor.as_ref() {
                params.insert("cursor".to_string(), Value::String(value.clone()));
            }
            let raw = session.request("tools/list", Value::Object(params), remaining)?;
            let page: McpToolPage = serde_json::from_value(raw).map_err(|error| {
                McpCommandError::new(
                    "protocol_error",
                    format!("invalid tools/list result: {error}"),
                )
                .for_server(&server_id)
            })?;
            pages_fetched += 1;
            if page.tools.len() > MAX_TOTAL_TOOLS.saturating_sub(tools.len()) {
                return Err(McpCommandError::new(
                    "protocol_error",
                    format!(
                        "tools/list exceeded the {MAX_TOTAL_TOOLS}-tool safety limit (received at least {})",
                        tools.len().saturating_add(page.tools.len())
                    ),
                )
                .for_server(&server_id));
            }
            tools.extend(page.tools);

            let next_cursor = page.next_cursor.filter(|value| !value.is_empty());
            if next_cursor.is_none() {
                return Ok(McpListToolsResult {
                    server_id,
                    tools,
                    next_cursor: None,
                    pages_fetched,
                    truncated: false,
                });
            }
            if !all_pages || pages_fetched >= max_pages {
                return Ok(McpListToolsResult {
                    server_id,
                    tools,
                    next_cursor,
                    pages_fetched,
                    truncated: true,
                });
            }

            let next = next_cursor.unwrap_or_default();
            if !seen_cursors.insert(next.clone()) {
                return Err(McpCommandError::new(
                    "protocol_error",
                    format!("tools/list returned the repeated cursor `{next}`"),
                )
                .for_server(&server_id));
            }
            cursor = Some(next);
        }
    }

    pub(super) fn call_tool(
        &self,
        input: McpCallToolInput,
    ) -> Result<McpCallToolResult, McpCommandError> {
        let server_id = normalize_identifier(&input.server_id, "serverId")?;
        let session_token = normalize_identifier(&input.session_token, "sessionToken")
            .map_err(|error| error.for_server(&server_id))?;
        let tool_name = normalize_identifier(&input.name, "name")
            .map_err(|error| error.for_server(&server_id))?;
        let session = self.session(&server_id, &session_token)?;
        let timeout = session.resolve_timeout(input.timeout_ms, "timeoutMs")?;

        let mut params = Map::new();
        params.insert("name".to_string(), Value::String(tool_name.clone()));
        params.insert(
            "arguments".to_string(),
            Value::Object(input.arguments.unwrap_or_default()),
        );
        if let Some(meta) = input.meta {
            params.insert("_meta".to_string(), Value::Object(meta));
        }

        let raw = session.request("tools/call", Value::Object(params), timeout)?;
        let result: McpToolCallPayload = serde_json::from_value(raw).map_err(|error| {
            McpCommandError::new(
                "protocol_error",
                format!("invalid tools/call result: {error}"),
            )
            .for_server(&server_id)
        })?;

        Ok(McpCallToolResult {
            server_id,
            tool_name,
            result,
        })
    }

    pub(super) fn disconnect(
        &self,
        input: McpDisconnectInput,
    ) -> Result<McpDisconnectResult, McpCommandError> {
        let server_id = normalize_identifier(&input.server_id, "serverId")?;
        let session_token = normalize_identifier(&input.session_token, "sessionToken")
            .map_err(|error| error.for_server(&server_id))?;
        let grace_ms = input
            .grace_period_ms
            .unwrap_or(DEFAULT_DISCONNECT_GRACE_MS)
            .min(MAX_DISCONNECT_GRACE_MS);
        let session = {
            let mut registry = lock_recover(&self.inner.registry);
            let session = registry.sessions.get(&server_id).cloned().ok_or_else(|| {
                let message = if registry.connecting.contains(&server_id) {
                    format!("MCP server `{server_id}` is still connecting")
                } else if registry.closing.contains(&server_id) {
                    format!("MCP server `{server_id}` is disconnecting")
                } else {
                    format!("MCP server `{server_id}` is not connected")
                };
                McpCommandError::new("not_connected", message).for_server(&server_id)
            })?;
            if session.session_token != session_token {
                return Err(McpCommandError::new(
                    "stale_session",
                    format!("MCP server `{server_id}` belongs to a newer session"),
                )
                .for_server(&server_id));
            }
            registry
                .sessions
                .remove(&server_id)
                .expect("validated MCP session should still be registered");
            registry.closing.insert(server_id.clone());
            session
        };
        let outcome = session.close(Duration::from_millis(grace_ms));
        lock_recover(&self.inner.registry)
            .closing
            .remove(&server_id);

        Ok(McpDisconnectResult {
            server_id,
            session_token,
            exit_code: outcome.exit_code,
            forced_kill: outcome.forced_kill,
        })
    }

    fn session(
        &self,
        server_id: &str,
        session_token: &str,
    ) -> Result<Arc<McpSession>, McpCommandError> {
        let session = lock_recover(&self.inner.registry)
            .sessions
            .get(server_id)
            .cloned()
            .ok_or_else(|| {
                McpCommandError::new(
                    "not_connected",
                    format!("MCP server `{server_id}` is not connected"),
                )
                .for_server(server_id)
            })?;
        if session.session_token != session_token {
            return Err(McpCommandError::new(
                "stale_session",
                format!("MCP server `{server_id}` belongs to a newer session"),
            )
            .for_server(server_id));
        }
        Ok(session)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolPage {
    tools: Vec<McpTool>,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[cfg(test)]
#[path = "mcp_manager_tests.rs"]
mod tests;
