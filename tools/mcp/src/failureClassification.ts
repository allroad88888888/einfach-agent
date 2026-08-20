// Classifies why an MCP connect/reconcile/close failure happened, independent of the
// McpServerStatus it should produce. Kept separate from clientManager.ts so the mapping stays a
// small, pure, unit-testable surface.
//
// What this file decides, and what it no longer decides: failures that reached us through the host
// bridge arrive **already judged** (see attachMcpFailureVerdict) — the table keyed by the bridge's
// failure kinds lives in `packages/host-node/src/mcp/failureKinds.ts`, on the side that mints those
// kinds, and no copy of it is kept here. What is left is everything the bridge never sees: HTTP
// statuses observed by the Streamable HTTP transport, SDK errors, and this package's own strings.
import { toError, truncate } from './internal'

/**
 * The reasons this package labels a failure with. Not a closed contract with the host bridge: the
 * bridge mints its own reason vocabulary (`packages/host-node/src/mcp/failureKinds.ts`) and a value
 * missing from this union still keeps its verdict, it only falls back to a generic label. Keeping
 * the union closed is what makes REASON_LABEL exhaustive for the reasons produced *here*.
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
  /** One of McpFailureReason, or a reason handed down by the bridge that this build does not know. */
  reason: string
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
 * Property that carries the host bridge's failure verdict across the boundary.
 *
 * Non-enumerable so it never leaks into Error serialization or UI text.
 */
const FAILURE_VERDICT_KEY = 'mcpFailureVerdict'

/**
 * A verdict handed down by the side that owns the failure: may retrying help, and why did it fail.
 *
 * `reason` is deliberately an open string, not this package's McpFailureReason union. It crossed a
 * process boundary, so a build of this package can be older or newer than the bridge that minted
 * it; an unrecognized reason keeps the verdict and only falls back to a generic label
 * (see reasonLabel), which is a cosmetic loss rather than a retry-policy one.
 */
export interface McpFailureVerdict {
  /** False means retrying unchanged can never succeed: a human has to fix config/environment/server. */
  readonly retryable: boolean
  readonly reason: string
}

/**
 * Records the bridge's verdict on the Error that crosses into this package. Called by the app's
 * stdio connector (`apps/web/src/mcp/serverMcpCommands.ts`, which lifts it off the 502 envelope
 * `/api/invoke/:command` returns).
 *
 * **This package no longer holds any table keyed by the bridge's failure kinds.** It used to, and
 * that table had to be edited in lockstep with `packages/host-node/src/mcp/`; a permanent kind
 * added there and missed here fell through to the retryable default, and a server that can never
 * start got reconnected forever. The verdict now travels with the error, so adding or renaming a
 * kind on the bridge needs no change in this file. The single table lives in
 * `packages/host-node/src/mcp/failureKinds.ts`, where the kinds are minted.
 *
 * Attaching a verdict also *marks the error as the bridge's*: classifyMcpFailure() never matches
 * the message of such an error, because that text was written either by the bridge or by the
 * remote server — never by this package.
 */
export function attachMcpFailureVerdict<E extends Error>(
  error: E,
  verdict: McpFailureVerdict | undefined,
): E {
  if (verdict === undefined) return error
  Object.defineProperty(error, FAILURE_VERDICT_KEY, {
    value: { retryable: verdict.retryable, reason: verdict.reason },
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return error
}

/** Reads back a verdict recorded by attachMcpFailureVerdict(), if any. */
export function readMcpFailureVerdict(error: unknown): McpFailureVerdict | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Record<string, unknown>)[FAILURE_VERDICT_KEY]
  if (typeof value !== 'object' || value === null) return undefined
  const { retryable, reason } = value as { retryable?: unknown, reason?: unknown }
  if (typeof retryable !== 'boolean') return undefined
  if (typeof reason !== 'string' || reason.length === 0) return undefined
  return { retryable, reason }
}

/**
 * Permanent-failure message patterns sourced from this codebase's own thrown
 * errors (clientManager.ts validateConfig/reconcile, toolAdapter.ts,
 * streamableHttp.ts). These are deterministic, developer-authored strings
 * thrown inside this package, not third-party or cross-process text, so
 * matching on them is stable across releases.
 *
 * Two families are intentionally kept away from this table: anything that reached us through the
 * host bridge (it arrives with a verdict and is decided by it alone) and anything whose message
 * the peer helped write (an SDK McpError, or an HTTP status).
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

/**
 * A reason may arrive from the bridge (see McpFailureVerdict), so it is not necessarily one this
 * build knows a label for. An unlabelled reason keeps its verdict and only loses wording precision.
 * Object.hasOwn, not `in`: a reason of 'constructor' would otherwise pick a label off the prototype.
 */
function reasonLabel(reason: string): string {
  return Object.hasOwn(REASON_LABEL, reason) ? REASON_LABEL[reason as McpFailureReason] : '连接失败'
}

function buildMessage(reason: string, detail: string, permanent: boolean): string {
  const label = reasonLabel(reason)
  const advice = permanent
    ? '需要人工介入才能恢复'
    // 不说「谁」在重试：同一条分类既喂给自动退避的 clientManager，也喂给不重试的连接工具。
    : reason === 'auth'
      ? '可以重试；若反复失败请检查凭证配置'
      : '可以重试'
  const truncated = truncate(detail, DETAIL_MAX_CHARS)
  return `${label}，${advice}：${truncated}`
}

function permanent(reason: string, detail: string): McpFailureClassification {
  return { status: 'error', reason, message: buildMessage(reason, detail, true) }
}

function temporary(reason: string, detail: string): McpFailureClassification {
  return { status: 'reconnecting', reason, message: buildMessage(reason, detail, false) }
}

/**
 * Maps an arbitrary connect/reconcile/close failure to a status + reason.
 *
 * The single rule behind the order below: **a permanent verdict may only come
 * from a signal the peer does not author.** Those are the host bridge's verdict
 * (decided in `packages/host-node/src/mcp/failureKinds.ts` from the kind that
 * bridge minted itself, never from the failure message), the HTTP response
 * status, and this package's own thrown messages. Everything else — remote
 * JSON-RPC error text, HTTP response bodies, SDK prose — can at most choose the
 * reason label, and falls to the temporary default.
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

  // Structured first, and final: the bridge already decided, on a signal the peer cannot write.
  // Nothing below runs for such an error — in particular its message is never matched, because
  // that text belongs to the bridge or to the remote server, not to this package.
  const verdict = readMcpFailureVerdict(caught)
  if (verdict !== undefined) {
    if (!verdict.retryable) return permanent(verdict.reason, detail)
    // Label only, exactly like the isUnauthorizedMessage() branch further down: over stdio there is
    // no 401 to read, so this wording is the only auth hint there will ever be — and it may still
    // only relabel a retryable failure, never overturn the bridge's verdict.
    return temporary(isUnauthorizedMessage(detail) ? 'auth' : verdict.reason, detail)
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

  // The SDK's McpError wraps the remote's own error text; it may not reach the message rules.
  if (isSdkMcpError(caught)) {
    return temporary('connection_disrupted', detail)
  }

  for (const rule of PERMANENT_MESSAGE_RULES) {
    if (rule.pattern.test(detail)) {
      return permanent(rule.reason, detail)
    }
  }

  return temporary('connection_disrupted', detail)
}
