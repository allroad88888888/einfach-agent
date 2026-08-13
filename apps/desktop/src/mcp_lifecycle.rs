//! MCP 子进程生命周期事件的载荷、事件汇与通知器。

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter};

const MCP_STDIO_TOOLS_CHANGED_EVENT: &str = "mcp-stdio-tools-changed";
const MCP_STDIO_CLOSE_EVENT: &str = "mcp-stdio-close";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpLifecycleEventPayload {
    pub(super) server_id: String,
    pub(super) session_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpCloseEventPayload {
    pub(super) server_id: String,
    pub(super) session_token: String,
    pub(super) message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum McpLifecycleEvent {
    ToolsChanged(McpLifecycleEventPayload),
    Closed(McpCloseEventPayload),
}

#[derive(Clone)]
pub(super) struct McpLifecycleEventSink {
    emit: Arc<dyn Fn(McpLifecycleEvent) + Send + Sync>,
}

impl McpLifecycleEventSink {
    pub(super) fn from_app(app: AppHandle) -> Self {
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
    pub(super) fn new(emit: impl Fn(McpLifecycleEvent) + Send + Sync + 'static) -> Self {
        Self {
            emit: Arc::new(emit),
        }
    }

    pub(super) fn emit(&self, event: McpLifecycleEvent) {
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
pub(super) struct McpLifecycleNotifier {
    pub(super) server_id: String,
    pub(super) session_token: String,
    pub(super) event_sink: McpLifecycleEventSink,
    pub(super) closing: Arc<AtomicBool>,
    pub(super) close_event_sent: Arc<AtomicBool>,
}

impl McpLifecycleNotifier {
    pub(super) fn tools_changed(&self) {
        if self.closing.load(Ordering::Acquire) || self.close_event_sent.load(Ordering::Acquire) {
            return;
        }
        self.event_sink
            .emit(McpLifecycleEvent::ToolsChanged(McpLifecycleEventPayload {
                server_id: self.server_id.clone(),
                session_token: self.session_token.clone(),
            }));
    }

    pub(super) fn closed(&self, message: impl Into<String>) {
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
