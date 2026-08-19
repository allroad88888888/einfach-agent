// MCP 四条命令入参的归一化与校验
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_validation.rs（已随 T1 删除）。文案与 kind 逐字保留——两个宿主对同一份坏配置
// 必须说同一句话，且 `invalid_input` 这个 kind 会被 tools/mcp 的失败分类器当成「我方配置问题」
// 而不是「对端问题」，换个 kind 就会换一条重试策略。

import { McpCommandError } from './errors'
import { DEFAULT_PROTOCOL_VERSION, MAX_REQUEST_TIMEOUT_MS } from './limits'

/** 标识符（serverId / sessionToken / 工具名）的字节上限。Rust 是 `len() > 256`，即 **字节**。 */
const MAX_IDENTIFIER_BYTES = 256

// Rust 的 `str::trim` 按 Unicode White_Space 属性修剪，`String.prototype.trim()` **不等价**
// （JS 多剪 U+FEFF、少剪 U+0085）。差别落在 serverId 上就是「同一个配置在两个宿主里被归一化成
// 两个不同的 ID」，于是登记表对不上而没人报错。
//
// 【这是本仓库第二份同样的定义】第一份是 workspace/git/unicodeWhitespace.ts。正解是上提到
// workspace/common/，但那是另一张卡的改动面，本卡不越界动它——已在交回报告里点名。
const WHITESPACE_PREFIX = /^\p{White_Space}+/u
const WHITESPACE_SUFFIX = /\p{White_Space}+$/u

/** 等价 Rust 的 `str::trim`。 */
export function trimUnicodeWhitespace(value: string): string {
  return value.replace(WHITESPACE_PREFIX, '').replace(WHITESPACE_SUFFIX, '')
}

/**
 * 归一化一个标识符：修剪首尾空白，拒空、拒 NUL、拒超长。
 *
 * NUL 那一条不是洁癖：Rust 侧用 serverId 拼线程名（`mcp-{server_id}-stdout`），带 NUL 会 panic。
 * Node 这边没有线程名，但这条**照留**——它同时是「别让 ID 里混进 C 字符串终止符」的通用防线，
 * 而且移植时放宽任何一条校验，都会让两个宿主对同一份输入给出不同判决。
 */
export function normalizeIdentifier(value: string, fieldName: string): string {
  const normalized = trimUnicodeWhitespace(value)
  if (normalized.length === 0) {
    throw new McpCommandError('invalid_input', `${fieldName} must not be empty`)
  }
  if (normalized.includes('\0')) {
    throw new McpCommandError('invalid_input', `${fieldName} must not contain null bytes`)
  }
  // 必须按**字节**量，不是 `.length`（UTF-16 码元）：一个汉字 3 字节 / 1 码元，按码元判会放进
  // 一个 Rust 侧会拒掉的 ID。
  if (Buffer.byteLength(normalized, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new McpCommandError(
      'invalid_input',
      `${fieldName} must not exceed ${MAX_IDENTIFIER_BYTES} bytes`,
    )
  }
  return normalized
}

/**
 * 只判命令非空，**不返回修剪后的值**——与 Rust 一致，spawn 用的仍是原始字符串。
 *
 * 这不是疏忽：修剪后再 spawn 等于替用户改了他配置里的命令，而 `" node"` 这种带前导空格的
 * 配置在两个宿主里必须同样地失败（OS 找不到名为 `" node"` 的可执行文件），不能一个悄悄修好、
 * 一个报错。
 */
export function validateCommand(command: string, serverId: string): void {
  if (trimUnicodeWhitespace(command).length === 0) {
    throw new McpCommandError('invalid_input', 'command must not be empty').forServer(serverId)
  }
}

/** 协议版本：不传取默认，传了必须**逐字**等于本客户端实现的那一版，不降级协商。 */
export function normalizeProtocolVersion(value: string | undefined): string {
  if (value === undefined) return DEFAULT_PROTOCOL_VERSION
  const trimmed = trimUnicodeWhitespace(value)
  if (trimmed.length === 0) {
    throw new McpCommandError('invalid_input', 'protocolVersion must not be empty')
  }
  if (trimmed !== DEFAULT_PROTOCOL_VERSION) {
    throw new McpCommandError(
      'invalid_input',
      `unsupported protocolVersion \`${trimmed}\`; this client supports only \`${DEFAULT_PROTOCOL_VERSION}\``,
    )
  }
  return trimmed
}

/** 握手双方的实现信息（clientInfo / serverInfo）。已知字段之外的键原样透传。 */
export interface McpImplementationInfo {
  name: string
  version: string
  title?: string
  [key: string]: unknown
}

/**
 * 对齐 Rust `McpImplementationInfo` 的 serde 形状。
 *
 * `title` 是 `Option<String>` + `skip_serializing_if = "Option::is_none"`：对端发来的
 * `"title": null` 反序列化成 `None`，再序列化时**整个键消失**。直接透传会留下一个
 * `title: null`，于是同一台服务在两个宿主上给出两份不同的 serverInfo。
 * 其余未知字段（Rust 的 `#[serde(flatten)] extra`）原样保留，含值为 null 的。
 */
export function normalizeImplementationInfo(
  record: Record<string, unknown>,
  name: string,
  version: string,
): McpImplementationInfo {
  const info: Record<string, unknown> = { ...record, name, version }
  if (info.title === null) delete info.title
  return info as McpImplementationInfo
}

/**
 * 不传 clientInfo 时报给对端的默认身份。
 *
 * **有意与 Rust 不同**（Rust 是 `web-agent-desktop` + 桌面 crate 版本）：clientInfo 是一句
 * 「正在跟你说话的是谁」的自述，Node 宿主自称桌面版是**假话**，而对端可能据此做兼容分支。
 * 仓库里没有任何代码解析这个值，改它不构成行为分叉；真正的调用方（apps/web 的 connector）
 * 一律显式传 clientInfo，这份默认只在直调路由表时生效。
 */
const DEFAULT_CLIENT_INFO: McpImplementationInfo = {
  name: 'web-agent-node',
  version: '0.1.0',
  title: 'Einfach Agent Node Host',
}

export function normalizeClientInfo(
  clientInfo: McpImplementationInfo | undefined,
  serverId: string,
): McpImplementationInfo {
  const info = clientInfo ?? DEFAULT_CLIENT_INFO
  validatePeerInfo(info, 'clientInfo', serverId)
  return info
}

/** 握手信息的最低要求：名字与版本都不能是空白。对端不满足即判 `protocol_error`。 */
export function validatePeerInfo(
  info: McpImplementationInfo,
  fieldName: string,
  serverId: string,
): void {
  if (
    trimUnicodeWhitespace(info.name).length === 0
    || trimUnicodeWhitespace(info.version).length === 0
  ) {
    throw new McpCommandError(
      'protocol_error',
      `${fieldName}.name and ${fieldName}.version must not be empty`,
    ).forServer(serverId)
  }
}

/**
 * 超时归一化：不传取 default，**0 报错**，超上限**钳住不报错**。
 *
 * 「0 报错、超限钳住」这组不对称是 Rust 定的，照搬：0 表达的是「我要一个不可能满足的超时」，
 * 多半是调用方算错了；而要一个过长的超时只是乐观，钳到 10 分钟仍是一个合理的答案。
 */
export function normalizeTimeout(
  requested: number | undefined,
  defaultMs: number,
  fieldName: string,
  serverId: string,
): number {
  const milliseconds = requested ?? defaultMs
  if (milliseconds === 0) {
    throw new McpCommandError(
      'invalid_input',
      `${fieldName} must be greater than zero`,
    ).forServer(serverId)
  }
  return Math.min(milliseconds, MAX_REQUEST_TIMEOUT_MS)
}
