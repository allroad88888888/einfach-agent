//! MCP stdio 传输的协议版本、默认值与安全上限常量。

pub(super) const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";
pub(super) const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub(super) const MAX_REQUEST_TIMEOUT_MS: u64 = 10 * 60_000;
pub(super) const DEFAULT_DISCONNECT_GRACE_MS: u64 = 500;
pub(super) const MAX_DISCONNECT_GRACE_MS: u64 = 5_000;
pub(super) const DEFAULT_MAX_TOOL_PAGES: usize = 100;
pub(super) const MAX_TOOL_PAGES: usize = 1_000;
pub(super) const MAX_TOTAL_TOOLS: usize = 1_000;
pub(super) const MAX_PROTOCOL_LINE_BYTES: usize = 16 * 1024 * 1024;
pub(super) const STDERR_TAIL_BYTES: usize = 16 * 1024;
pub(super) const MAX_SESSION_TOKENS: usize = 10_000;
pub(super) const CHILD_WAIT_POLL_MS: u64 = 10;
