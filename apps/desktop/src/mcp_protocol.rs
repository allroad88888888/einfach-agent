//! MCP stdio 的 JSON-RPC 行协议读写与响应 / 通知分发。

use serde_json::{json, Value};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use super::lifecycle::McpLifecycleNotifier;
use super::limits::MAX_PROTOCOL_LINE_BYTES;
use super::support::{lock_recover, PendingRequests, SharedWriter};

#[derive(Debug, Clone)]
pub(super) enum RpcReply {
    Result(Value),
    Error(RpcFailure),
    Transport(String),
}

#[derive(Debug, Clone)]
pub(super) struct RpcFailure {
    pub(super) code: i64,
    pub(super) message: String,
    pub(super) data: Option<Value>,
}

pub(super) fn read_protocol_stream<R: Read>(
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

pub(super) fn write_json_line(writer: &SharedWriter, value: &Value) -> io::Result<()> {
    let mut guard = lock_recover(writer);
    let stream = guard
        .as_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "MCP stdin is closed"))?;
    serde_json::to_writer(&mut *stream, value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub(super) fn fail_pending(pending: &PendingRequests, reply: RpcReply) {
    let senders = lock_recover(pending)
        .drain()
        .map(|(_, sender)| sender)
        .collect::<Vec<_>>();
    for sender in senders {
        let _ = sender.send(reply.clone());
    }
}

#[cfg(test)]
#[path = "mcp_protocol_tests.rs"]
mod tests;
