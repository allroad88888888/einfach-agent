use super::*;
use crate::mcp::lifecycle::McpLifecycleEvent;
use crate::mcp::limits::DEFAULT_PROTOCOL_VERSION;
use serde_json::json;
use std::thread;

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
