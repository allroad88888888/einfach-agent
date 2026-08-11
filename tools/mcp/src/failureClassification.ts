import { toError, truncate } from './internal'

/**
 * Classifies why an MCP connect/reconcile/close failure happened, independent
 * of the McpServerStatus it should produce. Kept separate from
 * clientManager.ts so the mapping stays a small, pure, unit-testable surface.
 */
export type McpFailureReason =
  | 'auth'
  | 'config_invalid'
  | 'command_unavailable'
  | 'tool_limit_exceeded'
  | 'tool_name_collision'
  | 'unsupported_capability'
  | 'protocol_violation'
  | 'connection_disrupted'

export interface McpFailureClassification {
  /**
   * 'error'：永久失败，重试不会自愈，需要人工修正配置/环境/服务器实现。
   * 'reconnecting'：暂时失败（网络或传输层抖动、连接被对端关闭），可以重试。
   */
  status: 'error' | 'reconnecting'
  reason: McpFailureReason
  /** 用户可见的中文说明：属于哪一类、具体原因是什么。 */
  message: string
}

const DETAIL_MAX_CHARS = 2_000

const REASON_LABEL: Record<McpFailureReason, string> = {
  auth: '身份认证失败',
  config_invalid: '服务器地址或配置无效',
  command_unavailable: '命令不存在或无法执行',
  tool_limit_exceeded: '工具数量超出限制',
  tool_name_collision: '工具名称冲突',
  unsupported_capability: '服务器要求的能力不受支持',
  protocol_violation: '服务器返回的数据不符合协议',
  connection_disrupted: '连接暂时中断',
}

/**
 * Property that carries the desktop stdio bridge's structured failure kind
 * (`McpCommandError.kind`, apps/desktop/src/mcp.rs) across the Tauri boundary.
 */
const FAILURE_KIND_KEY = 'mcpFailureKind'

/**
 * Records the desktop bridge's structured `McpCommandError.kind` on the Error
 * that crosses into TypeScript. Called by the host's stdio connector
 * (apps/web/src/mcp/tauriStdioConnector.ts) — this is the *declared* channel
 * that replaces matching on the bridge's human-readable message. The property
 * is non-enumerable so it never leaks into Error serialization or UI text.
 */
export function attachMcpFailureKind<E extends Error>(
  error: E,
  kind: string | undefined,
): E {
  if (typeof kind !== 'string' || kind.length === 0) return error
  Object.defineProperty(error, FAILURE_KIND_KEY, {
    value: kind,
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return error
}

/** Reads back a kind recorded by attachMcpFailureKind(), if any. */
export function readMcpFailureKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const kind = (error as Record<string, unknown>)[FAILURE_KIND_KEY]
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined
}

/**
 * Structured kinds that mean "retrying will never succeed on its own".
 *
 * Only kinds listed here are permanent; every other kind — including ones the
 * Rust side adds later — falls through to the remaining checks and then to the
 * temporary default, so a new kind can never silently reclassify an existing
 * failure. Rewording the Rust message cannot downgrade a permanent failure
 * either, because nothing here reads the message.
 */
const PERMANENT_FAILURE_KINDS: Readonly<Record<string, McpFailureReason | undefined>> = {
  // apps/desktop/src/mcp.rs McpSession::spawn — the OS refused to start the
  // configured command (missing binary / not executable / no permission).
  // Deliberately distinct from `spawn_failed`, which is a host-side setup
  // failure *after* the child started (pipe capture, helper threads) and
  // stays retryable.
  command_spawn_failed: 'command_unavailable',
  // apps/desktop/src/mcp.rs — the peer broke the MCP contract: an unparseable
  // tools/list / tools/call / initialize result, a repeated pagination cursor, a
  // protocolVersion this client does not implement, a missing tools capability.
  // None of those become valid by reconnecting. Judged structurally *because*
  // the Rust message inlines the server's cursor and protocolVersion verbatim,
  // so a server answering `protocolVersion: "must not be empty"` could otherwise
  // pick its own reason out of PERMANENT_MESSAGE_RULES.
  protocol_error: 'protocol_violation',
}

/**
 * Structured kinds whose message quotes the remote MCP server word for word.
 * The text is the peer's, so no verdict may be inferred by matching it: these
 * skip PERMANENT_MESSAGE_RULES and fall to the temporary default.
 *
 * The rest of apps/desktop/src/mcp.rs is host-authored and stays matchable:
 * `invalid_input` reports on our own config; `transport_closed`,
 * `transport_error`, `process_exited`, `process_error` and `spawn_failed` report
 * host/OS conditions (every RpcReply::Transport string is written by the bridge,
 * not received from the child); `timeout`, `already_connected`, `stale_session`,
 * `session_limit` and `not_connected` are fixed bridge strings.
 */
const PEER_AUTHORED_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  // apps/desktop/src/mcp.rs RpcReply::Error — the message reads
  // "MCP request `m` failed: {server error.message} ({code})", so everything
  // after the colon is written by the server being talked to. Left matchable, a
  // healthy server answering "must not be empty" or "exceeded 5 tools" would be
  // declared permanently broken and never retried again.
  'rpc_error',
])

/**
 * Permanent-failure message patterns sourced from this codebase's own thrown
 * errors (clientManager.ts validateConfig/reconcile, toolAdapter.ts,
 * streamableHttp.ts). These are deterministic, developer-authored strings
 * thrown inside this package, not third-party or cross-process text, so
 * matching on them is stable across releases.
 *
 * Two families are intentionally kept away from this table: the desktop stdio
 * bridge (classified through the structured kinds above) and anything whose
 * message the peer helped write (hasPeerAuthoredMessage / an HTTP status).
 */
const PERMANENT_MESSAGE_RULES: ReadonlyArray<{
  reason: McpFailureReason
  pattern: RegExp
}> = [
  { reason: 'config_invalid', pattern: /must not be empty/i },
  { reason: 'config_invalid', pattern: /must use http or https/i },
  { reason: 'config_invalid', pattern: /unsupported mcp transport/i },
  { reason: 'tool_limit_exceeded', pattern: /exceeded \d+ tools\b/i },
  { reason: 'tool_name_collision', pattern: /colliding tool names/i },
  { reason: 'tool_name_collision', pattern: /conflicts with an existing tool/i },
  { reason: 'unsupported_capability', pattern: /requires task-based execution/i },
  { reason: 'protocol_violation', pattern: /exceeded \d+ pages\b/i },
  { reason: 'protocol_violation', pattern: /exceeded \d+ bytes\b/i },
  { reason: 'protocol_violation', pattern: /returned an invalid tool list/i },
  { reason: 'protocol_violation', pattern: /returned a tool with an empty name/i },
  { reason: 'protocol_violation', pattern: /repeated cursor/i },
  { reason: 'protocol_violation', pattern: /has a non-object input schema/i },
  { reason: 'protocol_violation', pattern: /unexpected content type/i },
  {
    reason: 'protocol_violation',
    pattern: /exceeds the .*(character|level|node)|contains a (cyclic or repeated|non-json|non-finite|symbol-keyed)/i,
  },
]

/**
 * The MCP SDK's McpError (@modelcontextprotocol/sdk types.ts) relays a remote
 * JSON-RPC failure: it sets `name` to 'McpError', puts the *server's* error code
 * in `code`, and formats the message as "MCP error {code}: {server message}".
 * Matched on the declared `name` rather than instanceof, which a second copy of
 * the SDK in the dependency graph would silently defeat.
 */
function isSdkMcpError(error: Error): boolean {
  return error.name === 'McpError'
}

/**
 * Duck-typed HTTP status carried by transport errors such as the SDK's
 * StreamableHTTPError, whose `code` is the response status. `code` is
 * deliberately not read off an McpError: JSON-RPC reserves nothing in the
 * 100–599 range, so a server replying `{"code": 403}` could otherwise mint an
 * "HTTP 403" auth verdict for itself and stop us from ever reconnecting.
 */
function readHttpStatus(error: Error): number | undefined {
  if (isSdkMcpError(error)) return undefined
  const record = error as unknown as Record<string, unknown>
  for (const key of ['status', 'code', 'statusCode'] as const) {
    const value = record[key]
    if (Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599) {
      return value as number
    }
  }
  return undefined
}

/** True when part of the failure message was written by the remote MCP server. */
function hasPeerAuthoredMessage(error: Error): boolean {
  const kind = readMcpFailureKind(error)
  if (kind !== undefined && PEER_AUTHORED_MESSAGE_KINDS.has(kind)) return true
  return isSdkMcpError(error)
}

/**
 * Third-party prose that *looks* like an auth rejection. Unlike
 * PERMANENT_MESSAGE_RULES this matches wording owned by remote servers and by
 * the SDK, which may be localized, reworded between releases, or echoed back by
 * a server that is not failing on auth at all. It is therefore only allowed to
 * pick the reason label — never the permanent/temporary verdict; see
 * classifyMcpFailure() for why temporary is the safe side of that trade.
 */
function isUnauthorizedMessage(message: string): boolean {
  return /unauthoriz|authentication failed|invalid token|invalid credentials|invalid api key/i.test(
    message,
  )
}

function buildMessage(reason: McpFailureReason, detail: string, permanent: boolean): string {
  const label = REASON_LABEL[reason]
  const advice = permanent
    ? '需要人工介入才能恢复'
    : reason === 'auth'
      ? '会自动重试，若一直失败请检查凭证配置'
      : '可以重试'
  const truncated = truncate(detail, DETAIL_MAX_CHARS)
  return `${label}，${advice}：${truncated}`
}

function permanent(reason: McpFailureReason, detail: string): McpFailureClassification {
  return { status: 'error', reason, message: buildMessage(reason, detail, true) }
}

function temporary(reason: McpFailureReason, detail: string): McpFailureClassification {
  return { status: 'reconnecting', reason, message: buildMessage(reason, detail, false) }
}

/**
 * Maps an arbitrary connect/reconcile/close failure to a status + reason.
 *
 * The single rule behind the order below: **a permanent verdict may only come
 * from a signal the peer does not author.** Those are the desktop bridge's
 * structured kind, the HTTP response status, and this package's own thrown
 * messages. Everything else — remote JSON-RPC error text, HTTP response
 * bodies, SDK prose — can at most choose the reason label, and falls to the
 * temporary default.
 *
 * That asymmetry is deliberate, because the two mistakes do not cost the same
 * once the caller retries with capped exponential backoff:
 *   - calling a temporary failure permanent stops all retries and needs a human,
 *     and the peer can trigger it at will by echoing "invalid token" or
 *     "exceeded 5 tools" in an ordinary 500;
 *   - calling a permanent failure temporary costs a bounded handful of backed-off
 *     attempts, after which the retry budget runs out and the same failure
 *     surfaces anyway.
 *
 * This function does not schedule or perform any retry; it only decides which
 * of 'error' | 'reconnecting' a failure deserves.
 */
export function classifyMcpFailure(error: unknown): McpFailureClassification {
  const caught = toError(error)
  const detail = caught.message

  // Structured first: a typed kind from the desktop bridge outranks every
  // heuristic below, and is the only thing the stdio path is judged on.
  const kind = readMcpFailureKind(caught)
  const kindReason = kind === undefined ? undefined : PERMANENT_FAILURE_KINDS[kind]
  if (kindReason !== undefined) {
    return permanent(kindReason, detail)
  }

  // An HTTP status is observed by the transport, not written by the server, so
  // it is both trustworthy and terminal: the verdict is a function of the number
  // alone. The prose beside it is the response body — the SDK inlines it as
  // "Error POSTing to endpoint: {body}" — so letting it reach the message rules
  // would hand the peer a switch for turning its own 500 into a permanent
  // failure. Is a structured auth signal always available? Over Streamable HTTP
  // yes: the SDK always throws StreamableHTTPError(status, …). Over stdio, and
  // for in-band JSON-RPC auth errors, no — those deliberately stay retryable.
  const httpStatus = readHttpStatus(caught)
  if (httpStatus !== undefined) {
    const httpDetail = `HTTP ${httpStatus}：${detail}`
    if (httpStatus === 401 || httpStatus === 403) {
      return permanent('auth', httpDetail)
    }
    if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
      return permanent('config_invalid', httpDetail)
    }
    return temporary('connection_disrupted', httpDetail)
  }

  // Label only. Without a 401/403 the "unauthorized" wording is the peer's or
  // the SDK's, and is not allowed to end retrying.
  if (isUnauthorizedMessage(detail)) {
    return temporary('auth', detail)
  }

  if (hasPeerAuthoredMessage(caught)) {
    return temporary('connection_disrupted', detail)
  }

  for (const rule of PERMANENT_MESSAGE_RULES) {
    if (rule.pattern.test(detail)) {
      return permanent(rule.reason, detail)
    }
  }

  return temporary('connection_disrupted', detail)
}
