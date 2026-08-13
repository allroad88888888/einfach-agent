//! 单个 MCP stdio 会话的请求收发、初始化握手与关闭。

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    process::Child,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use super::limits::{CHILD_WAIT_POLL_MS, DEFAULT_DISCONNECT_GRACE_MS, DEFAULT_PROTOCOL_VERSION};
use super::process::{join_thread, kill_child};
use super::protocol::{fail_pending, write_json_line, RpcReply};
use super::support::{
    duration_millis, lock_recover, PendingRequests, SharedStderrTail, SharedWriter,
};
use super::types::{McpCommandError, McpConnectResult, McpImplementationInfo};
use super::validation::{normalize_timeout, validate_peer_info};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpInitializePayload {
    protocol_version: String,
    capabilities: Value,
    server_info: McpImplementationInfo,
    #[serde(default)]
    instructions: Option<String>,
}

pub(super) struct McpSession {
    pub(super) server_id: String,
    pub(super) session_token: String,
    pub(super) pid: u32,
    pub(super) default_timeout: Duration,
    pub(super) child: Arc<Mutex<Option<Child>>>,
    pub(super) writer: SharedWriter,
    pub(super) pending: PendingRequests,
    pub(super) next_request_id: AtomicU64,
    pub(super) closing: Arc<AtomicBool>,
    pub(super) transport_closed: Arc<AtomicBool>,
    pub(super) stderr_tail: SharedStderrTail,
    pub(super) reader_handle: Mutex<Option<JoinHandle<()>>>,
    pub(super) stderr_handle: Mutex<Option<JoinHandle<()>>>,
    pub(super) process_handle: Mutex<Option<JoinHandle<()>>>,
    pub(super) close_lock: Mutex<()>,
    pub(super) close_outcome: Mutex<Option<CloseOutcome>>,
}

#[derive(Debug, Clone)]
pub(super) struct CloseOutcome {
    pub(super) exit_code: Option<i32>,
    pub(super) forced_kill: bool,
}

impl McpSession {
    pub(super) fn initialize(
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

    pub(super) fn resolve_timeout(
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

    pub(super) fn request(
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

    pub(super) fn close(&self, grace: Duration) -> CloseOutcome {
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
