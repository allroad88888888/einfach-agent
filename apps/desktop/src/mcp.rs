use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{self, BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MAX_REQUEST_TIMEOUT_MS: u64 = 10 * 60_000;
const DEFAULT_DISCONNECT_GRACE_MS: u64 = 500;
const MAX_DISCONNECT_GRACE_MS: u64 = 5_000;
const DEFAULT_MAX_TOOL_PAGES: usize = 100;
const MAX_TOOL_PAGES: usize = 1_000;
const MAX_TOTAL_TOOLS: usize = 1_000;
const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 16 * 1024;
const MAX_SESSION_TOKENS: usize = 10_000;
const CHILD_WAIT_POLL_MS: u64 = 10;
const MCP_STDIO_TOOLS_CHANGED_EVENT: &str = "mcp-stdio-tools-changed";
const MCP_STDIO_CLOSE_EVENT: &str = "mcp-stdio-close";

type SharedWriter = Arc<Mutex<Option<ChildStdin>>>;
type PendingRequests = Arc<Mutex<HashMap<u64, mpsc::SyncSender<RpcReply>>>>;
type SharedStderrTail = Arc<Mutex<TailBuffer>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Box<Value>>,
}

impl McpCommandError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
            server_id: None,
            rpc_code: None,
            data: None,
        }
    }

    fn for_server(mut self, server_id: &str) -> Self {
        self.server_id = Some(server_id.to_string());
        self
    }

    fn worker(message: impl Into<String>) -> Self {
        Self::new("worker_failed", message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImplementationInfo {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectInput {
    pub server_id: String,
    pub session_token: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub request_timeout_ms: Option<u64>,
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub client_info: Option<McpImplementationInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub server_id: String,
    pub session_token: String,
    pub pid: u32,
    pub protocol_version: String,
    pub capabilities: Value,
    pub server_info: McpImplementationInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsInput {
    pub server_id: String,
    pub session_token: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub all_pages: Option<bool>,
    #[serde(default)]
    pub max_pages: Option<usize>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsResult {
    pub server_id: String,
    pub tools: Vec<McpTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub pages_fetched: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolInput {
    pub server_id: String,
    pub session_token: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Option<Map<String, Value>>,
    #[serde(default)]
    pub meta: Option<Map<String, Value>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallPayload {
    #[serde(default)]
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResult {
    pub server_id: String,
    pub tool_name: String,
    #[serde(flatten)]
    pub result: McpToolCallPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDisconnectInput {
    pub server_id: String,
    pub session_token: String,
    #[serde(default)]
    pub grace_period_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDisconnectResult {
    pub server_id: String,
    pub session_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub forced_kill: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpLifecycleEventPayload {
    server_id: String,
    session_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpCloseEventPayload {
    server_id: String,
    session_token: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq)]
enum McpLifecycleEvent {
    ToolsChanged(McpLifecycleEventPayload),
    Closed(McpCloseEventPayload),
}

#[derive(Clone)]
struct McpLifecycleEventSink {
    emit: Arc<dyn Fn(McpLifecycleEvent) + Send + Sync>,
}

impl McpLifecycleEventSink {
    fn from_app(app: AppHandle) -> Self {
        Self {
            emit: Arc::new(move |event| {
                let result = match event {
                    McpLifecycleEvent::ToolsChanged(payload) => {
                        app.emit(MCP_STDIO_TOOLS_CHANGED_EVENT, payload)
                    }
                    McpLifecycleEvent::Closed(payload) => app.emit(MCP_STDIO_CLOSE_EVENT, payload),
                };
                if let Err(error) = result {
                    log::warn!("failed to emit MCP lifecycle event: {error}");
                }
            }),
        }
    }

    #[cfg(test)]
    fn new(emit: impl Fn(McpLifecycleEvent) + Send + Sync + 'static) -> Self {
        Self {
            emit: Arc::new(emit),
        }
    }

    fn emit(&self, event: McpLifecycleEvent) {
        (self.emit)(event);
    }
}

impl Default for McpLifecycleEventSink {
    fn default() -> Self {
        Self {
            emit: Arc::new(|_| {}),
        }
    }
}

#[derive(Clone)]
struct McpLifecycleNotifier {
    server_id: String,
    session_token: String,
    event_sink: McpLifecycleEventSink,
    closing: Arc<AtomicBool>,
    close_event_sent: Arc<AtomicBool>,
}

impl McpLifecycleNotifier {
    fn tools_changed(&self) {
        if self.closing.load(Ordering::Acquire) || self.close_event_sent.load(Ordering::Acquire) {
            return;
        }
        self.event_sink
            .emit(McpLifecycleEvent::ToolsChanged(McpLifecycleEventPayload {
                server_id: self.server_id.clone(),
                session_token: self.session_token.clone(),
            }));
    }

    fn closed(&self, message: impl Into<String>) {
        if self.closing.load(Ordering::Acquire)
            || self.close_event_sent.swap(true, Ordering::AcqRel)
        {
            return;
        }
        self.event_sink
            .emit(McpLifecycleEvent::Closed(McpCloseEventPayload {
                server_id: self.server_id.clone(),
                session_token: self.session_token.clone(),
                message: message.into(),
            }));
    }
}

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

impl McpManager {
    #[cfg(test)]
    fn connect(&self, input: McpConnectInput) -> Result<McpConnectResult, McpCommandError> {
        self.connect_with_events(input, McpLifecycleEventSink::default())
    }

    fn connect_with_events(
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

    fn list_tools(&self, input: McpListToolsInput) -> Result<McpListToolsResult, McpCommandError> {
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

    fn call_tool(&self, input: McpCallToolInput) -> Result<McpCallToolResult, McpCommandError> {
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

    fn disconnect(
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
struct McpInitializePayload {
    protocol_version: String,
    capabilities: Value,
    server_info: McpImplementationInfo,
    #[serde(default)]
    instructions: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolPage {
    tools: Vec<McpTool>,
    #[serde(default)]
    next_cursor: Option<String>,
}

struct McpSession {
    server_id: String,
    session_token: String,
    pid: u32,
    default_timeout: Duration,
    child: Arc<Mutex<Option<Child>>>,
    writer: SharedWriter,
    pending: PendingRequests,
    next_request_id: AtomicU64,
    closing: Arc<AtomicBool>,
    transport_closed: Arc<AtomicBool>,
    stderr_tail: SharedStderrTail,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    stderr_handle: Mutex<Option<JoinHandle<()>>>,
    process_handle: Mutex<Option<JoinHandle<()>>>,
    close_lock: Mutex<()>,
    close_outcome: Mutex<Option<CloseOutcome>>,
}

#[derive(Debug, Clone)]
struct CloseOutcome {
    exit_code: Option<i32>,
    forced_kill: bool,
}

impl McpSession {
    fn spawn(
        server_id: &str,
        session_token: &str,
        input: &McpConnectInput,
        default_timeout: Duration,
        event_sink: McpLifecycleEventSink,
    ) -> Result<Arc<Self>, McpCommandError> {
        let mut command = Command::new(&input.command);
        command
            .args(&input.args)
            .envs(&input.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = input.cwd.as_ref().filter(|value| !value.is_empty()) {
            command.current_dir(cwd);
        }
        configure_child_process(&mut command);

        // `command_spawn_failed` is the structured signal for "the OS refused to
        // start the configured command" — missing binary, not executable, or no
        // permission. It is deliberately a different kind from `spawn_failed`
        // below, which covers host-side setup failures *after* the child already
        // started (pipe capture, helper threads) and is worth retrying. The web
        // side classifies stdio failures on this kind alone
        // (tools/mcp/src/failureClassification.ts), so the message text below is
        // free to change without downgrading a permanent failure.
        let mut child = command.spawn().map_err(|error| {
            McpCommandError::new(
                "command_spawn_failed",
                format!("failed to start MCP server `{server_id}`: {error}"),
            )
            .for_server(server_id)
        })?;
        let pid = child.id();
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                terminate_spawned_child(&mut child);
                return Err(McpCommandError::new(
                    "spawn_failed",
                    "failed to capture MCP server stdin",
                )
                .for_server(server_id));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                drop(stdin);
                terminate_spawned_child(&mut child);
                return Err(McpCommandError::new(
                    "spawn_failed",
                    "failed to capture MCP server stdout",
                )
                .for_server(server_id));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                drop(stdin);
                drop(stdout);
                terminate_spawned_child(&mut child);
                return Err(McpCommandError::new(
                    "spawn_failed",
                    "failed to capture MCP server stderr",
                )
                .for_server(server_id));
            }
        };

        let writer = Arc::new(Mutex::new(Some(stdin)));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let transport_closed = Arc::new(AtomicBool::new(false));
        let closing = Arc::new(AtomicBool::new(false));
        let stderr_tail = Arc::new(Mutex::new(TailBuffer::new(STDERR_TAIL_BYTES)));
        let lifecycle = McpLifecycleNotifier {
            server_id: server_id.to_string(),
            session_token: session_token.to_string(),
            event_sink,
            closing: Arc::clone(&closing),
            close_event_sent: Arc::new(AtomicBool::new(false)),
        };

        let stderr_handle = {
            let tail = Arc::clone(&stderr_tail);
            match thread::Builder::new()
                .name(format!("mcp-{server_id}-stderr"))
                .spawn(move || drain_stderr(stderr, tail))
            {
                Ok(handle) => handle,
                Err(error) => {
                    drop(lock_recover(&writer).take());
                    terminate_spawned_child(&mut child);
                    return Err(McpCommandError::new(
                        "spawn_failed",
                        format!("failed to start MCP stderr reader: {error}"),
                    )
                    .for_server(server_id));
                }
            }
        };

        let reader_handle = {
            let reader_writer = Arc::clone(&writer);
            let reader_pending = Arc::clone(&pending);
            let reader_closed = Arc::clone(&transport_closed);
            let reader_server_id = server_id.to_string();
            let reader_lifecycle = lifecycle.clone();
            match thread::Builder::new()
                .name(format!("mcp-{server_id}-stdout"))
                .spawn(move || {
                    read_protocol_stream(
                        stdout,
                        reader_writer,
                        reader_pending,
                        reader_closed,
                        reader_server_id,
                        reader_lifecycle,
                    )
                }) {
                Ok(handle) => handle,
                Err(error) => {
                    drop(lock_recover(&writer).take());
                    terminate_spawned_child(&mut child);
                    let _ = stderr_handle.join();
                    return Err(McpCommandError::new(
                        "spawn_failed",
                        format!("failed to start MCP protocol reader: {error}"),
                    )
                    .for_server(server_id));
                }
            }
        };

        let child = Arc::new(Mutex::new(Some(child)));
        let process_handle = {
            let process_child = Arc::clone(&child);
            let process_writer = Arc::clone(&writer);
            let process_pending = Arc::clone(&pending);
            let process_closed = Arc::clone(&transport_closed);
            let process_lifecycle = lifecycle;
            match thread::Builder::new()
                .name(format!("mcp-{server_id}-process"))
                .spawn(move || {
                    watch_child_process(
                        process_child,
                        process_writer,
                        process_pending,
                        process_closed,
                        process_lifecycle,
                    )
                }) {
                Ok(handle) => handle,
                Err(error) => {
                    closing.store(true, Ordering::Release);
                    drop(lock_recover(&writer).take());
                    if let Some(mut child) = lock_recover(&child).take() {
                        terminate_spawned_child(&mut child);
                    }
                    let _ = reader_handle.join();
                    let _ = stderr_handle.join();
                    return Err(McpCommandError::new(
                        "spawn_failed",
                        format!("failed to start MCP process watcher: {error}"),
                    )
                    .for_server(server_id));
                }
            }
        };

        Ok(Arc::new(Self {
            server_id: server_id.to_string(),
            session_token: session_token.to_string(),
            pid,
            default_timeout,
            child,
            writer,
            pending,
            next_request_id: AtomicU64::new(1),
            closing,
            transport_closed,
            stderr_tail,
            reader_handle: Mutex::new(Some(reader_handle)),
            stderr_handle: Mutex::new(Some(stderr_handle)),
            process_handle: Mutex::new(Some(process_handle)),
            close_lock: Mutex::new(()),
            close_outcome: Mutex::new(None),
        }))
    }

    fn initialize(
        &self,
        requested_protocol_version: &str,
        client_info: &McpImplementationInfo,
    ) -> Result<McpConnectResult, McpCommandError> {
        let raw = self.request(
            "initialize",
            json!({
                "protocolVersion": requested_protocol_version,
                "capabilities": {},
                "clientInfo": client_info,
            }),
            self.default_timeout,
        )?;
        let initialized: McpInitializePayload = serde_json::from_value(raw).map_err(|error| {
            McpCommandError::new(
                "protocol_error",
                format!("invalid initialize result: {error}"),
            )
            .for_server(&self.server_id)
        })?;
        if initialized.protocol_version.trim().is_empty() {
            return Err(McpCommandError::new(
                "protocol_error",
                "initialize result contains an empty protocolVersion",
            )
            .for_server(&self.server_id));
        }
        if initialized.protocol_version != DEFAULT_PROTOCOL_VERSION {
            return Err(McpCommandError::new(
                "protocol_error",
                format!(
                    "MCP server selected unsupported protocolVersion `{}`; this client supports only `{DEFAULT_PROTOCOL_VERSION}`",
                    initialized.protocol_version
                ),
            )
            .for_server(&self.server_id));
        }
        if !initialized.capabilities.is_object() {
            return Err(McpCommandError::new(
                "protocol_error",
                "initialize result capabilities must be an object",
            )
            .for_server(&self.server_id));
        }
        if !initialized
            .capabilities
            .get("tools")
            .is_some_and(Value::is_object)
        {
            return Err(McpCommandError::new(
                "protocol_error",
                "MCP server does not declare the required tools capability",
            )
            .for_server(&self.server_id));
        }
        validate_peer_info(&initialized.server_info, "serverInfo", &self.server_id)?;
        self.send_notification("notifications/initialized", None)?;

        Ok(McpConnectResult {
            server_id: self.server_id.clone(),
            session_token: self.session_token.clone(),
            pid: self.pid,
            protocol_version: initialized.protocol_version,
            capabilities: initialized.capabilities,
            server_info: initialized.server_info,
            instructions: initialized.instructions,
        })
    }

    fn resolve_timeout(
        &self,
        requested: Option<u64>,
        field_name: &str,
    ) -> Result<Duration, McpCommandError> {
        match requested {
            None => Ok(self.default_timeout),
            Some(value) => normalize_timeout(
                Some(value),
                duration_millis(self.default_timeout),
                field_name,
                &self.server_id,
            ),
        }
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, McpCommandError> {
        self.ensure_running()?;
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = lock_recover(&self.pending);
            if self.closing.load(Ordering::Acquire) || self.transport_closed.load(Ordering::Acquire)
            {
                return Err(McpCommandError::new(
                    "transport_closed",
                    "MCP server transport is closed",
                )
                .for_server(&self.server_id));
            }
            pending.insert(id, sender);
        }

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = write_json_line(&self.writer, &message) {
            lock_recover(&self.pending).remove(&id);
            return Err(McpCommandError::new(
                "transport_error",
                format!("failed to write MCP request `{method}`: {error}"),
            )
            .for_server(&self.server_id));
        }

        match receiver.recv_timeout(timeout) {
            Ok(RpcReply::Result(value)) => Ok(value),
            Ok(RpcReply::Error(error)) => Err(McpCommandError {
                kind: "rpc_error".to_string(),
                message: format!(
                    "MCP request `{method}` failed: {} ({})",
                    error.message, error.code
                ),
                server_id: Some(self.server_id.clone()),
                rpc_code: Some(error.code),
                data: error.data.map(Box::new),
            }),
            Ok(RpcReply::Transport(message)) => Err(McpCommandError::new(
                "transport_closed",
                format!("MCP request `{method}` failed: {message}"),
            )
            .for_server(&self.server_id)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock_recover(&self.pending).remove(&id);
                Err(McpCommandError::new(
                    "timeout",
                    format!(
                        "MCP request `{method}` timed out after {} ms",
                        duration_millis(timeout)
                    ),
                )
                .for_server(&self.server_id))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                lock_recover(&self.pending).remove(&id);
                Err(McpCommandError::new(
                    "transport_closed",
                    format!("MCP response channel for `{method}` closed unexpectedly"),
                )
                .for_server(&self.server_id))
            }
        }
    }

    fn send_notification(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), McpCommandError> {
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
        message.insert("method".to_string(), Value::String(method.to_string()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        write_json_line(&self.writer, &Value::Object(message)).map_err(|error| {
            McpCommandError::new(
                "transport_error",
                format!("failed to write MCP notification `{method}`: {error}"),
            )
            .for_server(&self.server_id)
        })
    }

    fn ensure_running(&self) -> Result<(), McpCommandError> {
        if self.closing.load(Ordering::Acquire) || self.transport_closed.load(Ordering::Acquire) {
            return Err(
                McpCommandError::new("transport_closed", "MCP server transport is closed")
                    .for_server(&self.server_id),
            );
        }

        let exited = {
            let mut child = lock_recover(&self.child);
            match child.as_mut() {
                Some(child) => child.try_wait().map_err(|error| {
                    McpCommandError::new(
                        "process_error",
                        format!("failed to inspect MCP server process: {error}"),
                    )
                    .for_server(&self.server_id)
                })?,
                None => {
                    return Err(McpCommandError::new(
                        "transport_closed",
                        "MCP server process has already been cleaned up",
                    )
                    .for_server(&self.server_id))
                }
            }
        };
        if let Some(status) = exited {
            self.transport_closed.store(true, Ordering::Release);
            return Err(McpCommandError::new(
                "process_exited",
                format!(
                    "MCP server exited before the request (exit code {:?})",
                    status.code()
                ),
            )
            .for_server(&self.server_id));
        }
        Ok(())
    }

    fn close(&self, grace: Duration) -> CloseOutcome {
        let _close_guard = lock_recover(&self.close_lock);
        if let Some(outcome) = lock_recover(&self.close_outcome).clone() {
            return outcome;
        }

        self.closing.store(true, Ordering::Release);
        self.transport_closed.store(true, Ordering::Release);
        fail_pending(
            &self.pending,
            RpcReply::Transport("MCP server is disconnecting".to_string()),
        );
        drop(lock_recover(&self.writer).take());

        let mut forced_kill = false;
        let mut exit_code = None;
        let mut child = lock_recover(&self.child).take();
        if let Some(child) = child.as_mut() {
            let deadline = Instant::now() + grace;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        exit_code = status.code();
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(CHILD_WAIT_POLL_MS));
                    }
                    Ok(None) => {
                        forced_kill = true;
                        let _ = kill_child(child);
                        exit_code = child.wait().ok().and_then(|status| status.code());
                        break;
                    }
                    Err(_) => {
                        forced_kill = true;
                        let _ = kill_child(child);
                        exit_code = child.wait().ok().and_then(|status| status.code());
                        break;
                    }
                }
            }
        }

        join_thread(&self.reader_handle, "protocol reader", &self.stderr_tail);
        join_thread(&self.stderr_handle, "stderr reader", &self.stderr_tail);
        join_thread(&self.process_handle, "process watcher", &self.stderr_tail);
        let outcome = CloseOutcome {
            exit_code,
            forced_kill,
        };
        *lock_recover(&self.close_outcome) = Some(outcome.clone());
        outcome
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.close(Duration::from_millis(DEFAULT_DISCONNECT_GRACE_MS));
    }
}

#[derive(Debug, Clone)]
enum RpcReply {
    Result(Value),
    Error(RpcFailure),
    Transport(String),
}

#[derive(Debug, Clone)]
struct RpcFailure {
    code: i64,
    message: String,
    data: Option<Value>,
}

fn read_protocol_stream<R: Read>(
    stdout: R,
    writer: SharedWriter,
    pending: PendingRequests,
    transport_closed: Arc<AtomicBool>,
    server_id: String,
    lifecycle: McpLifecycleNotifier,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        match read_protocol_line(&mut reader, &mut line) {
            Ok(Some(ProtocolLine::Message)) => match serde_json::from_slice::<Value>(&line) {
                Ok(value) => handle_protocol_value(value, &writer, &pending, &lifecycle),
                Err(error) => {
                    log::warn!(
                        "ignoring malformed JSON line from MCP server `{}`: {}",
                        server_id,
                        error
                    );
                }
            },
            Ok(Some(ProtocolLine::TooLarge)) => {
                log::warn!(
                    "discarded an oversized protocol line from MCP server `{}`",
                    server_id
                );
                fail_pending(
                    &pending,
                    RpcReply::Transport(format!(
                        "MCP server sent a message larger than {} bytes",
                        MAX_PROTOCOL_LINE_BYTES
                    )),
                );
            }
            Ok(None) => {
                let message = "MCP server closed stdout".to_string();
                transport_closed.store(true, Ordering::Release);
                fail_pending(&pending, RpcReply::Transport(message.clone()));
                lifecycle.closed(message);
                break;
            }
            Err(error) => {
                let message = format!("failed to read MCP server stdout: {error}");
                transport_closed.store(true, Ordering::Release);
                fail_pending(&pending, RpcReply::Transport(message.clone()));
                lifecycle.closed(message);
                break;
            }
        }
    }
}

enum ProtocolLine {
    Message,
    TooLarge,
}

fn read_protocol_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> io::Result<Option<ProtocolLine>> {
    line.clear();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if oversized {
                return Ok(Some(ProtocolLine::TooLarge));
            }
            return if line.is_empty() {
                Ok(None)
            } else {
                trim_line_ending(line);
                Ok(Some(ProtocolLine::Message))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !oversized {
            if line.len().saturating_add(consumed) <= MAX_PROTOCOL_LINE_BYTES {
                line.extend_from_slice(&available[..consumed]);
            } else {
                line.clear();
                oversized = true;
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            if oversized {
                return Ok(Some(ProtocolLine::TooLarge));
            }
            trim_line_ending(line);
            return Ok(Some(ProtocolLine::Message));
        }
    }
}

fn trim_line_ending(line: &mut Vec<u8>) {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
}

fn handle_protocol_value(
    value: Value,
    writer: &SharedWriter,
    pending: &PendingRequests,
    lifecycle: &McpLifecycleNotifier,
) {
    match value {
        Value::Array(messages) => {
            for message in messages {
                handle_protocol_value(message, writer, pending, lifecycle);
            }
        }
        Value::Object(message) => {
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if let Some(id) = message.get("id") {
                    handle_server_request(method, id.clone(), writer);
                } else if method == "notifications/tools/list_changed" {
                    lifecycle.tools_changed();
                }
                // Other notifications intentionally produce no response or log noise.
                return;
            }

            let Some(id) = message.get("id").and_then(Value::as_u64) else {
                return;
            };
            let sender = lock_recover(pending).remove(&id);
            let Some(sender) = sender else {
                // A late response after a timeout, or an unsolicited response.
                return;
            };

            let reply = if let Some(error) = message.get("error") {
                RpcReply::Error(parse_rpc_error(error))
            } else if let Some(result) = message.get("result") {
                RpcReply::Result(result.clone())
            } else {
                RpcReply::Error(RpcFailure {
                    code: -32603,
                    message: "response contains neither result nor error".to_string(),
                    data: None,
                })
            };
            let _ = sender.send(reply);
        }
        _ => {}
    }
}

fn watch_child_process(
    child: Arc<Mutex<Option<Child>>>,
    writer: SharedWriter,
    pending: PendingRequests,
    transport_closed: Arc<AtomicBool>,
    lifecycle: McpLifecycleNotifier,
) {
    loop {
        if lifecycle.closing.load(Ordering::Acquire) {
            return;
        }

        let status = {
            let mut child = lock_recover(&child);
            match child.as_mut() {
                Some(child) => child.try_wait(),
                None => return,
            }
        };

        let message = match status {
            Ok(Some(status)) => {
                format!("MCP server process exited (exit code {:?})", status.code())
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(CHILD_WAIT_POLL_MS));
                continue;
            }
            Err(error) => format!("failed to inspect MCP server process: {error}"),
        };

        transport_closed.store(true, Ordering::Release);
        drop(lock_recover(&writer).take());
        fail_pending(&pending, RpcReply::Transport(message.clone()));
        lifecycle.closed(message);
        return;
    }
}

fn handle_server_request(method: &str, id: Value, writer: &SharedWriter) {
    let response = if method == "ping" {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {},
        })
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("client method `{method}` is not supported"),
            },
        })
    };
    let _ = write_json_line(writer, &response);
}

fn parse_rpc_error(value: &Value) -> RpcFailure {
    RpcFailure {
        code: value.get("code").and_then(Value::as_i64).unwrap_or(-32603),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown JSON-RPC error")
            .to_string(),
        data: value.get("data").cloned(),
    }
}

fn write_json_line(writer: &SharedWriter, value: &Value) -> io::Result<()> {
    let mut guard = lock_recover(writer);
    let stream = guard
        .as_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "MCP stdin is closed"))?;
    serde_json::to_writer(&mut *stream, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn fail_pending(pending: &PendingRequests, reply: RpcReply) {
    let senders = lock_recover(pending)
        .drain()
        .map(|(_, sender)| sender)
        .collect::<Vec<_>>();
    for sender in senders {
        let _ = sender.send(reply.clone());
    }
}

fn drain_stderr<R: Read>(mut stderr: R, tail: SharedStderrTail) {
    let mut buffer = [0u8; 4_096];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => lock_recover(&tail).push(&buffer[..read]),
            Err(error) => {
                lock_recover(&tail)
                    .push(format!("\n[failed to read MCP stderr: {error}]\n").as_bytes());
                break;
            }
        }
    }
}

struct TailBuffer {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl TailBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if self.bytes.len() == self.capacity {
                self.bytes.pop_front();
            }
            self.bytes.push_back(*byte);
        }
    }
}

fn join_thread(
    handle: &Mutex<Option<JoinHandle<()>>>,
    label: &str,
    stderr_tail: &SharedStderrTail,
) {
    if let Some(handle) = lock_recover(handle).take() {
        if handle.join().is_err() {
            lock_recover(stderr_tail)
                .push(format!("\n[MCP {label} thread terminated unexpectedly]\n").as_bytes());
        }
    }
}

fn normalize_identifier(value: &str, field_name: &str) -> Result<String, McpCommandError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(McpCommandError::new(
            "invalid_input",
            format!("{field_name} must not be empty"),
        ));
    }
    if normalized.contains('\0') {
        return Err(McpCommandError::new(
            "invalid_input",
            format!("{field_name} must not contain null bytes"),
        ));
    }
    if normalized.len() > 256 {
        return Err(McpCommandError::new(
            "invalid_input",
            format!("{field_name} must not exceed 256 bytes"),
        ));
    }
    Ok(normalized.to_string())
}

fn validate_command(command: &str, server_id: &str) -> Result<(), McpCommandError> {
    if command.trim().is_empty() {
        return Err(
            McpCommandError::new("invalid_input", "command must not be empty")
                .for_server(server_id),
        );
    }
    Ok(())
}

fn normalize_protocol_version(value: Option<&str>) -> Result<String, McpCommandError> {
    match value {
        Some(value) if value.trim().is_empty() => Err(McpCommandError::new(
            "invalid_input",
            "protocolVersion must not be empty",
        )),
        Some(value) if value.trim() != DEFAULT_PROTOCOL_VERSION => Err(McpCommandError::new(
            "invalid_input",
            format!(
                "unsupported protocolVersion `{}`; this client supports only `{DEFAULT_PROTOCOL_VERSION}`",
                value.trim()
            ),
        )),
        Some(value) => Ok(value.trim().to_string()),
        None => Ok(DEFAULT_PROTOCOL_VERSION.to_string()),
    }
}

fn normalize_client_info(
    client_info: Option<McpImplementationInfo>,
    server_id: &str,
) -> Result<McpImplementationInfo, McpCommandError> {
    let info = client_info.unwrap_or_else(|| McpImplementationInfo {
        name: "web-agent-desktop".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        title: Some("Einfach Agent Desktop".to_string()),
        extra: Map::new(),
    });
    validate_peer_info(&info, "clientInfo", server_id)?;
    Ok(info)
}

fn validate_peer_info(
    info: &McpImplementationInfo,
    field_name: &str,
    server_id: &str,
) -> Result<(), McpCommandError> {
    if info.name.trim().is_empty() || info.version.trim().is_empty() {
        return Err(McpCommandError::new(
            "protocol_error",
            format!("{field_name}.name and {field_name}.version must not be empty"),
        )
        .for_server(server_id));
    }
    Ok(())
}

fn normalize_timeout(
    requested: Option<u64>,
    default_ms: u64,
    field_name: &str,
    server_id: &str,
) -> Result<Duration, McpCommandError> {
    let milliseconds = requested.unwrap_or(default_ms);
    if milliseconds == 0 {
        return Err(McpCommandError::new(
            "invalid_input",
            format!("{field_name} must be greater than zero"),
        )
        .for_server(server_id));
    }
    Ok(Duration::from_millis(
        milliseconds.min(MAX_REQUEST_TIMEOUT_MS),
    ))
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn terminate_spawned_child(child: &mut Child) {
    let _ = kill_child(child);
    let _ = child.wait();
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_child_process(_command: &mut Command) {}

#[cfg(unix)]
fn kill_child(child: &mut Child) -> io::Result<()> {
    kill_process_group(child.id()).or_else(|_| child.kill())
}

#[cfg(not(unix))]
fn kill_child(child: &mut Child) -> io::Result<()> {
    child.kill()
}

#[cfg(unix)]
fn kill_process_group(pid: u32) -> io::Result<()> {
    use std::os::raw::c_int;

    const SIGKILL: c_int = 9;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    let pid = c_int::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "child pid is too large"))?;
    // The child is placed in its own process group at spawn, so a negative PID
    // terminates helper processes spawned by an MCP server as well.
    let result = unsafe { kill(-pid, SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connect_input(server_id: &str, mode: &str) -> McpConnectInput {
        McpConnectInput {
            server_id: server_id.to_string(),
            session_token: session_token(server_id),
            command: "node".to_string(),
            args: vec![
                format!("{}/tests/mcp-test-server.cjs", env!("CARGO_MANIFEST_DIR")),
                mode.to_string(),
                MAX_TOTAL_TOOLS.to_string(),
            ],
            cwd: None,
            env: HashMap::new(),
            request_timeout_ms: Some(1_000),
            protocol_version: None,
            client_info: None,
        }
    }

    fn session_token(server_id: &str) -> String {
        format!("{server_id}-session")
    }

    #[test]
    fn persistent_session_initializes_paginates_calls_and_disconnects() {
        let manager = McpManager::default();
        let connected = manager
            .connect(connect_input("functional", "functional"))
            .expect("fake server should initialize");
        assert_eq!(connected.server_id, "functional");
        assert_eq!(connected.protocol_version, DEFAULT_PROTOCOL_VERSION);
        assert_eq!(connected.server_info.name, "fake-server");
        assert_eq!(connected.instructions.as_deref(), Some("test server"));

        let listed = manager
            .list_tools(McpListToolsInput {
                server_id: "functional".to_string(),
                session_token: session_token("functional"),
                cursor: None,
                all_pages: None,
                max_pages: None,
                timeout_ms: Some(1_000),
            })
            .expect("tools/list should follow pagination");
        assert_eq!(listed.pages_fetched, 2);
        assert!(!listed.truncated);
        assert!(listed.next_cursor.is_none());
        assert_eq!(
            listed
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );

        let called = manager
            .call_tool(McpCallToolInput {
                server_id: "functional".to_string(),
                session_token: session_token("functional"),
                name: "first".to_string(),
                arguments: Some(Map::from_iter([("value".to_string(), json!(42))])),
                meta: Some(Map::from_iter([("traceId".to_string(), json!("test"))])),
                timeout_ms: Some(1_000),
            })
            .expect("tools/call should return its payload");
        assert_eq!(called.tool_name, "first");
        assert!(!called.result.is_error);
        assert_eq!(called.result.content[0]["text"], "called");
        assert_eq!(
            called.result.structured_content,
            Some(json!({ "ok": true }))
        );

        let disconnected = manager
            .disconnect(McpDisconnectInput {
                server_id: "functional".to_string(),
                session_token: session_token("functional"),
                grace_period_ms: Some(250),
            })
            .expect("disconnect should close stdin and reap the server");
        assert!(!disconnected.forced_kill);
        assert_eq!(disconnected.exit_code, Some(0));
        let serialized =
            serde_json::to_value(disconnected).expect("disconnect result should serialize");
        assert!(
            serialized.get("stderrTail").is_none(),
            "child stderr must never cross the Tauri command boundary"
        );
    }

    #[test]
    fn connect_rejects_protocol_versions_the_client_does_not_implement() {
        let manager = McpManager::default();
        let mut unsupported_request = connect_input("unsupported-input", "functional");
        unsupported_request.protocol_version = Some("2025-06-18".to_string());
        let request_error = manager
            .connect(unsupported_request)
            .expect_err("unsupported requested versions must fail before spawning");
        assert_eq!(request_error.kind, "invalid_input");
        assert!(request_error.message.contains("supports only"));

        let response_error = manager
            .connect(connect_input("unsupported-response", "unsupported"))
            .expect_err("unsupported server-selected versions must fail initialize");
        assert_eq!(response_error.kind, "protocol_error");
        assert_eq!(
            response_error.server_id.as_deref(),
            Some("unsupported-response")
        );
        assert!(response_error.message.contains("2099-01-01"));
        assert!(response_error.message.contains(DEFAULT_PROTOCOL_VERSION));
    }

    #[test]
    fn connect_rejects_servers_without_the_tools_capability() {
        let manager = McpManager::default();
        let error = manager
            .connect(connect_input("resources-only", "resources-only"))
            .expect_err("a tools-only client must reject servers without tools");

        assert_eq!(error.kind, "protocol_error");
        assert_eq!(error.server_id.as_deref(), Some("resources-only"));
        assert!(error.message.contains("tools capability"));
    }

    #[test]
    fn connect_reports_a_dedicated_kind_when_the_command_cannot_be_spawned() {
        let manager = McpManager::default();
        let mut missing = connect_input("missing-command", "functional");
        missing.command = "web-agent-mcp-binary-that-does-not-exist".to_string();
        missing.args = Vec::new();

        let error = manager
            .connect(missing)
            .expect_err("a command the OS cannot start must fail to connect");

        // The web side classifies stdio failures on this kind alone
        // (tools/mcp/src/failureClassification.ts). It must stay distinct from
        // the retryable `spawn_failed`, and it must survive serialization —
        // the message is free-form and is never parsed.
        assert_eq!(error.kind, "command_spawn_failed");
        assert_eq!(error.server_id.as_deref(), Some("missing-command"));
        let serialized = serde_json::to_value(&error).expect("error should serialize");
        assert_eq!(serialized["kind"], json!("command_spawn_failed"));
    }

    #[test]
    fn list_tools_rejects_more_than_the_cumulative_safety_limit() {
        let manager = McpManager::default();
        manager
            .connect(connect_input("tool-limit", "tool-limit"))
            .expect("fake server should initialize");

        let at_limit = manager
            .list_tools(McpListToolsInput {
                server_id: "tool-limit".to_string(),
                session_token: session_token("tool-limit"),
                cursor: None,
                all_pages: Some(false),
                max_pages: None,
                timeout_ms: Some(5_000),
            })
            .expect("exactly 1000 tools should remain allowed");
        assert_eq!(at_limit.tools.len(), MAX_TOTAL_TOOLS);
        assert!(at_limit.truncated);

        let error = manager
            .list_tools(McpListToolsInput {
                server_id: "tool-limit".to_string(),
                session_token: session_token("tool-limit"),
                cursor: None,
                all_pages: Some(true),
                max_pages: None,
                timeout_ms: Some(5_000),
            })
            .expect_err("1000 tools plus one on the next page must be rejected");
        assert_eq!(error.kind, "protocol_error");
        assert_eq!(error.server_id.as_deref(), Some("tool-limit"));
        assert!(error.message.contains("1000-tool safety limit"));
        assert!(error.message.contains("1001"));

        manager
            .disconnect(McpDisconnectInput {
                server_id: "tool-limit".to_string(),
                session_token: session_token("tool-limit"),
                grace_period_ms: Some(250),
            })
            .expect("limited session should remain disconnectable");
    }

    #[test]
    fn request_timeout_is_structured_and_session_remains_disconnectable() {
        let manager = McpManager::default();
        manager
            .connect(connect_input("timeout", "timeout"))
            .expect("fake server should initialize");

        let error = manager
            .call_tool(McpCallToolInput {
                server_id: "timeout".to_string(),
                session_token: session_token("timeout"),
                name: "never-returns".to_string(),
                arguments: None,
                meta: None,
                timeout_ms: Some(40),
            })
            .expect_err("ignored request should time out");
        assert_eq!(error.kind, "timeout");
        assert_eq!(error.server_id.as_deref(), Some("timeout"));

        let disconnected = manager
            .disconnect(McpDisconnectInput {
                server_id: "timeout".to_string(),
                session_token: session_token("timeout"),
                grace_period_ms: Some(250),
            })
            .expect("timed-out session should still disconnect");
        assert!(!disconnected.forced_kill);
    }

    #[test]
    fn invalid_server_id_is_rejected_without_spawning_or_panicking() {
        let manager = McpManager::default();
        let error = manager
            .connect(connect_input("bad\0thread-name", "functional"))
            .expect_err("null bytes must be rejected before building thread names");

        assert_eq!(error.kind, "invalid_input");
        assert_eq!(error.server_id, None);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_manager_kills_and_reaps_stubborn_server() {
        let manager = McpManager::default();
        let pid = manager
            .connect(connect_input("stubborn", "stubborn"))
            .expect("fake server should initialize")
            .pid;

        let started = Instant::now();
        drop(manager);

        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(
            !process_exists(pid),
            "manager drop must not leave server process {pid} running"
        );
    }

    #[test]
    fn tools_changed_notification_is_emitted_without_consuming_pending_response() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink = {
            let events = Arc::clone(&events);
            McpLifecycleEventSink::new(move |event| lock_recover(&events).push(event))
        };
        let closing = Arc::new(AtomicBool::new(false));
        let lifecycle = McpLifecycleNotifier {
            server_id: "generation".to_string(),
            session_token: "generation-session".to_string(),
            event_sink,
            closing: Arc::clone(&closing),
            close_event_sent: Arc::new(AtomicBool::new(false)),
        };
        let writer: SharedWriter = Arc::new(Mutex::new(None));
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::sync_channel(1);
        lock_recover(&pending).insert(7, sender);

        handle_protocol_value(
            json!({
                "jsonrpc": "2.0",
                "method": "notifications/tools/list_changed",
            }),
            &writer,
            &pending,
            &lifecycle,
        );

        assert!(lock_recover(&pending).contains_key(&7));
        assert_eq!(
            lock_recover(&events).as_slice(),
            &[McpLifecycleEvent::ToolsChanged(McpLifecycleEventPayload {
                server_id: "generation".to_string(),
                session_token: "generation-session".to_string(),
            })]
        );

        handle_protocol_value(
            json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": true } }),
            &writer,
            &pending,
            &lifecycle,
        );
        match receiver
            .recv()
            .expect("pending response should be delivered")
        {
            RpcReply::Result(value) => assert_eq!(value, json!({ "ok": true })),
            other => panic!("unexpected reply: {other:?}"),
        }

        lifecycle.closed("stdout closed");
        lifecycle.closed("process exited");
        assert_eq!(
            lock_recover(&events)
                .iter()
                .filter(|event| matches!(event, McpLifecycleEvent::Closed(_)))
                .count(),
            1,
            "stdout EOF and process exit must emit one close event"
        );

        closing.store(true, Ordering::Release);
        lifecycle.tools_changed();
        assert_eq!(lock_recover(&events).len(), 2);
    }

    #[test]
    fn exited_process_proactively_emits_a_token_scoped_close_event() {
        let manager = McpManager::default();
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink = {
            let events = Arc::clone(&events);
            McpLifecycleEventSink::new(move |event| lock_recover(&events).push(event))
        };
        let connected = manager
            .connect_with_events(connect_input("exiting", "exiting"), event_sink)
            .expect("server should initialize before exiting");
        assert_eq!(connected.session_token, session_token("exiting"));

        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline
            && !lock_recover(&events)
                .iter()
                .any(|event| matches!(event, McpLifecycleEvent::Closed(_)))
        {
            thread::sleep(Duration::from_millis(10));
        }

        let closed = lock_recover(&events)
            .iter()
            .filter_map(|event| match event {
                McpLifecycleEvent::Closed(payload) => Some(payload.clone()),
                McpLifecycleEvent::ToolsChanged(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].server_id, "exiting");
        assert_eq!(closed[0].session_token, session_token("exiting"));

        manager
            .disconnect(McpDisconnectInput {
                server_id: "exiting".to_string(),
                session_token: session_token("exiting"),
                grace_period_ms: Some(250),
            })
            .expect("exited process should remain cleanly disconnectable");
    }

    #[test]
    fn stale_session_commands_cannot_observe_or_remove_the_current_session() {
        let manager = McpManager::default();
        manager
            .connect(connect_input("generation", "functional"))
            .expect("current generation should connect");

        let stale_list = manager
            .list_tools(McpListToolsInput {
                server_id: "generation".to_string(),
                session_token: "old-session".to_string(),
                cursor: None,
                all_pages: None,
                max_pages: None,
                timeout_ms: Some(1_000),
            })
            .expect_err("stale list must not reach the current process");
        assert_eq!(stale_list.kind, "stale_session");

        let stale_call = manager
            .call_tool(McpCallToolInput {
                server_id: "generation".to_string(),
                session_token: "old-session".to_string(),
                name: "first".to_string(),
                arguments: None,
                meta: None,
                timeout_ms: Some(1_000),
            })
            .expect_err("stale call must not reach the current process");
        assert_eq!(stale_call.kind, "stale_session");

        let stale_disconnect = manager
            .disconnect(McpDisconnectInput {
                server_id: "generation".to_string(),
                session_token: "old-session".to_string(),
                grace_period_ms: Some(250),
            })
            .expect_err("late cleanup must not remove the current process");
        assert_eq!(stale_disconnect.kind, "stale_session");

        let listed = manager
            .list_tools(McpListToolsInput {
                server_id: "generation".to_string(),
                session_token: session_token("generation"),
                cursor: None,
                all_pages: None,
                max_pages: None,
                timeout_ms: Some(1_000),
            })
            .expect("current generation must remain usable");
        assert_eq!(listed.tools.len(), 2);

        manager
            .disconnect(McpDisconnectInput {
                server_id: "generation".to_string(),
                session_token: session_token("generation"),
                grace_period_ms: Some(250),
            })
            .expect("current generation should still disconnect normally");
    }

    #[test]
    fn reconnect_rejects_reused_tokens_and_waits_for_closing_generation() {
        let manager = McpManager::default();
        let first = connect_input("reuse-safe", "functional");
        manager
            .connect(first.clone())
            .expect("first generation should connect");
        manager
            .disconnect(McpDisconnectInput {
                server_id: "reuse-safe".to_string(),
                session_token: first.session_token.clone(),
                grace_period_ms: Some(250),
            })
            .expect("first generation should disconnect");

        let reused = manager
            .connect(first.clone())
            .expect_err("a token must never identify two process generations");
        assert_eq!(reused.kind, "stale_session");

        {
            lock_recover(&manager.inner.registry)
                .closing
                .insert("reuse-safe".to_string());
        }
        let mut second = first;
        second.session_token = "reuse-safe-session-2".to_string();
        let closing = manager
            .connect(second.clone())
            .expect_err("a replacement process must wait until close completes");
        assert_eq!(closing.kind, "already_connected");
        lock_recover(&manager.inner.registry)
            .closing
            .remove("reuse-safe");

        manager
            .connect(second.clone())
            .expect("a fresh token may connect after close completes");
        manager
            .disconnect(McpDisconnectInput {
                server_id: second.server_id,
                session_token: second.session_token,
                grace_period_ms: Some(250),
            })
            .expect("second generation should disconnect");
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        use std::os::raw::c_int;

        extern "C" {
            fn kill(pid: c_int, signal: c_int) -> c_int;
        }

        c_int::try_from(pid)
            .ok()
            .is_some_and(|pid| unsafe { kill(pid, 0) } == 0)
    }
}
