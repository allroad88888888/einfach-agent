//! MCP stdio 子进程的拉起与 stdout / stderr / 进程三条工作线程的装配。

use std::{
    collections::HashMap,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use super::lifecycle::{McpLifecycleEventSink, McpLifecycleNotifier};
use super::limits::STDERR_TAIL_BYTES;
use super::process::{
    configure_child_process, drain_stderr, terminate_spawned_child, watch_child_process, TailBuffer,
};
use super::protocol::read_protocol_stream;
use super::session::McpSession;
use super::support::lock_recover;
use super::types::{McpCommandError, McpConnectInput};

impl McpSession {
    pub(super) fn spawn(
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
}
