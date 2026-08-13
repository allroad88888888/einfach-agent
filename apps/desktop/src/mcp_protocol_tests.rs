use super::*;
use crate::mcp::lifecycle::{McpLifecycleEvent, McpLifecycleEventPayload, McpLifecycleEventSink};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};

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
