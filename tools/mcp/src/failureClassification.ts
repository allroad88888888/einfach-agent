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
 * Permanent-failure message patterns sourced from this codebase's own thrown
 * errors (clientManager.ts validateConfig/reconcile, toolAdapter.ts,
 * streamableHttp.ts) plus the desktop stdio bridge's spawn-failure text
 * (apps/desktop/src/mcp.rs `McpSession::spawn`). These are deterministic,
 * developer-authored strings, not third-party or localized text, so matching
 * on them is stable across releases.
 */
const PERMANENT_MESSAGE_RULES: ReadonlyArray<{
  reason: McpFailureReason
  pattern: RegExp
}> = [
  { reason: 'config_invalid', pattern: /must not be empty/i },
  { reason: 'config_invalid', pattern: /must use http or https/i },
  { reason: 'config_invalid', pattern: /unsupported mcp transport/i },
  {
    reason: 'command_unavailable',
    // apps/desktop/src/mcp.rs McpSession::spawn wraps OS spawn failures with
    // this exact prefix (command not found / not executable / no permission).
    pattern: /failed to start mcp server/i,
  },
  {
    reason: 'command_unavailable',
    pattern: /\benoent\b|command not found|no such file or directory|cannot find the file specified|is not recognized as an internal or external command|permission denied/i,
  },
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

/** Duck-typed HTTP status carried by errors such as the MCP SDK's StreamableHTTPError. */
function readHttpStatus(error: Error): number | undefined {
  const record = error as unknown as Record<string, unknown>
  for (const key of ['status', 'code', 'statusCode'] as const) {
    const value = record[key]
    if (Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599) {
      return value as number
    }
  }
  return undefined
}

function isUnauthorizedMessage(message: string): boolean {
  return /unauthoriz|authentication failed|invalid token|invalid credentials|invalid api key/i.test(
    message,
  )
}

function buildMessage(reason: McpFailureReason, detail: string, permanent: boolean): string {
  const label = REASON_LABEL[reason]
  const advice = permanent ? '需要人工介入才能恢复' : '可以重试'
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
 * Temporary (network/transport jitter, peer-closed connections) is the
 * fallback: only failures matching a known permanent signal — HTTP 401/403,
 * an "unauthorized"-shaped message, or one of this codebase's own
 * config/protocol/capability errors — are classified as permanent. This
 * function does not schedule or perform any retry; it only decides which of
 * 'error' | 'reconnecting' a failure deserves.
 */
export function classifyMcpFailure(error: unknown): McpFailureClassification {
  const caught = toError(error)
  const detail = caught.message

  const httpStatus = readHttpStatus(caught)
  if (httpStatus === 401 || httpStatus === 403) {
    return permanent('auth', `HTTP ${httpStatus}：${detail}`)
  }
  if (isUnauthorizedMessage(detail)) {
    return permanent('auth', detail)
  }
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
    return permanent('config_invalid', `HTTP ${httpStatus}：${detail}`)
  }

  for (const rule of PERMANENT_MESSAGE_RULES) {
    if (rule.pattern.test(detail)) {
      return permanent(rule.reason, detail)
    }
  }

  return temporary('connection_disrupted', detail)
}
