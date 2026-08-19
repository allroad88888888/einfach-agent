// 四条命令的返回形状，以及对端载荷的收窄
// ---------------------------------------------------------------------------
// 与 apps/desktop/src/mcp_types.rs 的 serde 输出逐字段对齐（`rename_all = "camelCase"`）。
// 形状必须一致到「键在不在」这一级：apps/web 的 connector 是同一份代码要接两个宿主，
// 它读 `result.tools` / `result.truncated` / `result.content` / `result.structuredContent`。
//
// 【serde 的两条隐性规则，不照搬就会漂】
//   ① `Option<T>` + `skip_serializing_if = "Option::is_none"`：**缺席是「键不存在」，不是 null**。
//      而且反序列化时 JSON 的 `null` 会变成 `None`——所以对端发来的 `"title": null` 在 Rust
//      那里进去是 None、出来是**没有 title 这个键**。直接透传会留下一个 `title: null`。
//   ② `#[serde(flatten)] extra`：协议允许的额外字段原样保留。所以不能只挑已知字段重建对象——
//      那会把对端未来加的字段悄悄吃掉。

import { McpCommandError } from './errors'
import type { McpImplementationInfo } from './validation'

export interface McpConnectResult {
  serverId: string
  sessionToken: string
  pid: number
  protocolVersion: string
  capabilities: unknown
  serverInfo: McpImplementationInfo
  instructions?: string
}

export interface McpListToolsResult {
  serverId: string
  tools: McpTool[]
  nextCursor?: string
  pagesFetched: number
  truncated: boolean
}

export interface McpDisconnectResult {
  serverId: string
  sessionToken: string
  exitCode?: number
  forcedKill: boolean
}

/** 一个远端工具。已知字段之外的键原样保留。 */
export type McpTool = Record<string, unknown> & { name: string; inputSchema: unknown }

/** tools/call 的载荷。`serverId` / `toolName` 由调用方平铺在同一层（Rust 的 `flatten`）。 */
export type McpToolCallPayload = Record<string, unknown> & {
  content: unknown[]
  isError: boolean
}

const TOOL_OPTIONAL_KEYS = ['title', 'description', 'outputSchema', 'annotations', '_meta'] as const
const PAYLOAD_OPTIONAL_KEYS = ['structuredContent', '_meta'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(serverId: string, message: string): McpCommandError {
  return new McpCommandError('protocol_error', message).forServer(serverId)
}

/**
 * 收窄一页 tools/list 的结果。
 *
 * 失败文案的**前缀**与 Rust 逐字相同（`invalid tools/list result: `），后半段不可能相同——
 * Rust 那半句是 serde 生成的（`missing field \`inputSchema\` at line 1 column 42`），
 * 没有等价物。这不构成行为分叉：`protocol_error` 这个 kind 才是失败分类器的判据，
 * 而 message 在那条路上一个字都不读（见 failureClassification.ts 对 `protocol_error` 的注释）。
 */
export function narrowToolPage(
  raw: unknown,
  serverId: string,
): { tools: McpTool[]; nextCursor: string | undefined } {
  if (!isRecord(raw)) {
    throw protocolError(serverId, 'invalid tools/list result: expected an object')
  }
  if (!Array.isArray(raw.tools)) {
    throw protocolError(serverId, 'invalid tools/list result: `tools` must be an array')
  }
  const nextCursor = raw.nextCursor
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') {
    throw protocolError(serverId, 'invalid tools/list result: `nextCursor` must be a string')
  }
  return {
    tools: raw.tools.map((tool) => narrowTool(tool, serverId)),
    nextCursor: typeof nextCursor === 'string' ? nextCursor : undefined,
  }
}

/**
 * 一个工具的最低形状：`name` 是字符串、`inputSchema` **这个键存在**。
 *
 * 有意**不判 inputSchema 是不是对象**——Rust 那边它是 `Value`，什么都收；真正的形状校验在
 * tools/mcp 的 `normalizeTool` 与 schema 校验器里，那才是懂 MCP 语义的一层。在传输层多加
 * 一道判据，等于让同一条规则住两个地方，将来只会改一处。
 */
function narrowTool(raw: unknown, serverId: string): McpTool {
  if (!isRecord(raw)) {
    throw protocolError(serverId, 'invalid tools/list result: a tool entry is not an object')
  }
  if (typeof raw.name !== 'string') {
    throw protocolError(serverId, 'invalid tools/list result: a tool is missing a string `name`')
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'inputSchema')) {
    throw protocolError(
      serverId,
      `invalid tools/list result: tool \`${raw.name}\` is missing \`inputSchema\``,
    )
  }
  return dropNullOptionals({ ...raw }, TOOL_OPTIONAL_KEYS) as McpTool
}

/** tools/call 的返回载荷。`content` 缺省空数组、`isError` 缺省 false（Rust 的 `#[serde(default)]`）。 */
export function narrowToolCallPayload(raw: unknown, serverId: string): McpToolCallPayload {
  if (!isRecord(raw)) {
    throw protocolError(serverId, 'invalid tools/call result: expected an object')
  }
  const content = raw.content
  if (content !== undefined && content !== null && !Array.isArray(content)) {
    throw protocolError(serverId, 'invalid tools/call result: `content` must be an array')
  }
  const isError = raw.isError
  if (isError !== undefined && isError !== null && typeof isError !== 'boolean') {
    throw protocolError(serverId, 'invalid tools/call result: `isError` must be a boolean')
  }
  const payload = dropNullOptionals({ ...raw }, PAYLOAD_OPTIONAL_KEYS)
  return {
    ...payload,
    content: Array.isArray(content) ? content : [],
    isError: isError === true,
  }
}

/** 把值为 null 的可选字段整键删掉——见文件头 serde 规则①。 */
function dropNullOptionals(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  for (const key of keys) {
    if (record[key] === null) delete record[key]
  }
  return record
}
