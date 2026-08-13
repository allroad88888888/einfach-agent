//! MCP 命令入参的归一化与校验。

use serde_json::Map;
use std::time::Duration;

use super::limits::{DEFAULT_PROTOCOL_VERSION, MAX_REQUEST_TIMEOUT_MS};
use super::types::{McpCommandError, McpImplementationInfo};

pub(super) fn normalize_identifier(
    value: &str,
    field_name: &str,
) -> Result<String, McpCommandError> {
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

pub(super) fn validate_command(command: &str, server_id: &str) -> Result<(), McpCommandError> {
    if command.trim().is_empty() {
        return Err(
            McpCommandError::new("invalid_input", "command must not be empty")
                .for_server(server_id),
        );
    }
    Ok(())
}

pub(super) fn normalize_protocol_version(value: Option<&str>) -> Result<String, McpCommandError> {
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

pub(super) fn normalize_client_info(
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

pub(super) fn validate_peer_info(
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

pub(super) fn normalize_timeout(
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
