// MCP 握手：initialize 请求、结果校验、notifications/initialized
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_session.rs 的 `McpSession::initialize`。
//
// ═══ 为什么传输层里会有握手（这不是"重写协议编排"）═══
// `mcp_connect` 这条命令的**返回值就是 initialize 的结果**（protocolVersion / capabilities /
// serverInfo / instructions），它没有「只搬字节、不认协议」的实现形态。而 tools/mcp 里也**没有**
// 第二份 stdio 握手可以复用：全仓 grep 过，`tools/mcp` 里一次 `jsonrpc` / `tools/list` 字面量
// 都没有——Streamable HTTP 那条路的握手在官方 SDK 里，stdio 这条路的握手就只在 Rust 这一份。
// 所以本文件是把**唯一那一份**从 Rust 挪到 Node，不是造第二份。
//
// ═══ 四条校验一条都不能松（docs/mcp-integration.md「支持范围」）═══
// 本客户端只实现 tools，且只认 `2025-11-25`，不做降级协商。松掉任何一条的后果不是"兼容性更好"，
// 而是把一个不满足假设的对端放进来，再在 tools/list 或 tools/call 那里以更难懂的方式失败。

import { McpCommandError } from './errors'
import { DEFAULT_PROTOCOL_VERSION } from './limits'
import type { McpConnectResult } from './results'
import type { McpSession } from './session'
import {
  normalizeImplementationInfo,
  validatePeerInfo,
  type McpImplementationInfo,
} from './validation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(serverId: string, message: string): McpCommandError {
  return new McpCommandError('protocol_error', message).forServer(serverId)
}

export async function initializeSession(
  session: McpSession,
  requestedProtocolVersion: string,
  clientInfo: McpImplementationInfo,
): Promise<McpConnectResult> {
  const raw = await session.request(
    'initialize',
    {
      protocolVersion: requestedProtocolVersion,
      // 本客户端**不声明任何 capability**：不实现 sampling / roots / elicitation，
      // 声明了就是对对端撒谎，它会据此发我们答不上来的请求。
      capabilities: {},
      clientInfo,
    },
    session.defaultTimeoutMs,
  )

  const payload = narrowInitializePayload(raw, session.serverId)

  if (payload.protocolVersion.trim().length === 0) {
    throw protocolError(session.serverId, 'initialize result contains an empty protocolVersion')
  }
  if (payload.protocolVersion !== DEFAULT_PROTOCOL_VERSION) {
    throw protocolError(
      session.serverId,
      `MCP server selected unsupported protocolVersion \`${payload.protocolVersion}\`; this client supports only \`${DEFAULT_PROTOCOL_VERSION}\``,
    )
  }
  if (!isRecord(payload.capabilities)) {
    throw protocolError(session.serverId, 'initialize result capabilities must be an object')
  }
  // 声明了 resources / prompts 但没有 tools 的服务**直接拒**，不降级成「先连上再说」。
  // 本项目刻意只实现 tools；连上一台没有 tools 的服务，模型侧看到的是一个永远空的工具集。
  if (!isRecord(payload.capabilities.tools)) {
    throw protocolError(
      session.serverId,
      'MCP server does not declare the required tools capability',
    )
  }
  validatePeerInfo(payload.serverInfo, 'serverInfo', session.serverId)

  // 握手的最后一步。**在全部校验通过之后才发**：对一台刚被判定为不兼容的服务宣布
  // 「我准备好了」，会让它开始推送通知，而我们正要把它关掉。
  await session.notify('notifications/initialized')

  return {
    serverId: session.serverId,
    sessionToken: session.sessionToken,
    pid: session.pid,
    protocolVersion: payload.protocolVersion,
    capabilities: payload.capabilities,
    serverInfo: payload.serverInfo,
    ...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
  }
}

interface InitializePayload {
  protocolVersion: string
  capabilities: unknown
  serverInfo: McpImplementationInfo
  instructions: string | undefined
}

/**
 * 对齐 Rust 的 `McpInitializePayload` 反序列化：三个字段必填，`instructions` 可选。
 * 文案前缀 `invalid initialize result: ` 逐字保留（后半段是 serde 生成的，无等价物）。
 */
function narrowInitializePayload(raw: unknown, serverId: string): InitializePayload {
  if (!isRecord(raw)) {
    throw protocolError(serverId, 'invalid initialize result: expected an object')
  }
  const protocolVersion = raw.protocolVersion
  if (typeof protocolVersion !== 'string') {
    throw protocolError(serverId, 'invalid initialize result: `protocolVersion` must be a string')
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'capabilities')) {
    throw protocolError(serverId, 'invalid initialize result: missing `capabilities`')
  }
  const serverInfo = raw.serverInfo
  if (
    !isRecord(serverInfo)
    || typeof serverInfo.name !== 'string'
    || typeof serverInfo.version !== 'string'
  ) {
    throw protocolError(
      serverId,
      'invalid initialize result: `serverInfo` must carry string `name` and `version`',
    )
  }
  const instructions = raw.instructions
  if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
    throw protocolError(serverId, 'invalid initialize result: `instructions` must be a string')
  }
  return {
    protocolVersion,
    capabilities: raw.capabilities,
    serverInfo: normalizeImplementationInfo(serverInfo, serverInfo.name, serverInfo.version),
    instructions: typeof instructions === 'string' ? instructions : undefined,
  }
}
