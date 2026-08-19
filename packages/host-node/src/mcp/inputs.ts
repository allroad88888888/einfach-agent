// 四条 mcp 命令的入参形状与收窄
// ---------------------------------------------------------------------------
// 形状以 `commandArgs.ts` 的 mcp 段为准（那是收窄的**目标**，不是收窄本身），键名与
// apps/desktop/src/mcp_types.rs 的 `rename_all = "camelCase"` 逐字对齐。
//
// 四条命令的实参都包在一层 `input` 里（Tauri 的 `input: McpConnectInput` 参数名），所以每个
// handler 先剥这一层。**别把它抹平**：apps/web 的 connector 发的就是 `{ input: {...} }`，
// 抹平会让同一个 connector 在两个宿主上一个能用一个不能。

import {
  optionalBoolean,
  optionalRecord,
  optionalString,
  optionalStringArray,
  optionalStringRecord,
  optionalUnsignedInteger,
  requireRecord,
  requireString,
} from './argNarrowing'
import { McpCommandError } from './errors'
import { normalizeImplementationInfo, type McpImplementationInfo } from './validation'

export interface McpConnectInput {
  serverId: string
  sessionToken: string
  /** 原样交给 spawn 的可执行文件名/路径。**绝不拼进 shell 字符串**，见 childProcess.ts。 */
  command: string
  args: string[]
  cwd: string | undefined
  env: Record<string, string>
  requestTimeoutMs: number | undefined
  protocolVersion: string | undefined
  clientInfo: McpImplementationInfo | undefined
}

export interface McpListToolsInput {
  serverId: string
  sessionToken: string
  cursor: string | undefined
  allPages: boolean | undefined
  maxPages: number | undefined
  timeoutMs: number | undefined
}

export interface McpCallToolInput {
  serverId: string
  sessionToken: string
  name: string
  /** 键名就叫 `arguments`（MCP 协议用词）。内容不解释，原样进 `tools/call` 的 params。 */
  arguments: Record<string, unknown> | undefined
  meta: Record<string, unknown> | undefined
  timeoutMs: number | undefined
}

export interface McpDisconnectInput {
  serverId: string
  sessionToken: string
  gracePeriodMs: number | undefined
}

/** 剥掉外层 `input`。 */
function payloadOf(args: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(args.input, 'input')
}

export function narrowConnectInput(args: Record<string, unknown>): McpConnectInput {
  const input = payloadOf(args)
  const cwd = optionalString(input.cwd, 'input.cwd')
  return {
    serverId: requireString(input.serverId, 'input.serverId'),
    sessionToken: requireString(input.sessionToken, 'input.sessionToken'),
    command: requireString(input.command, 'input.command'),
    args: optionalStringArray(input.args, 'input.args'),
    // Rust 的 spawn 侧写的是 `.filter(|value| !value.is_empty())`——空串 cwd 等于没配。
    // 判在这里而不是 spawn 那边，是为了让「配置里存了个空 cwd」这件事只有一处答案。
    cwd: cwd === undefined || cwd.length === 0 ? undefined : cwd,
    env: optionalStringRecord(input.env, 'input.env'),
    requestTimeoutMs: optionalUnsignedInteger(input.requestTimeoutMs, 'input.requestTimeoutMs'),
    protocolVersion: optionalString(input.protocolVersion, 'input.protocolVersion'),
    clientInfo: narrowImplementationInfo(input.clientInfo, 'input.clientInfo'),
  }
}

export function narrowListToolsInput(args: Record<string, unknown>): McpListToolsInput {
  const input = payloadOf(args)
  return {
    serverId: requireString(input.serverId, 'input.serverId'),
    sessionToken: requireString(input.sessionToken, 'input.sessionToken'),
    cursor: optionalString(input.cursor, 'input.cursor'),
    allPages: optionalBoolean(input.allPages, 'input.allPages'),
    maxPages: optionalUnsignedInteger(input.maxPages, 'input.maxPages'),
    timeoutMs: optionalUnsignedInteger(input.timeoutMs, 'input.timeoutMs'),
  }
}

export function narrowCallToolInput(args: Record<string, unknown>): McpCallToolInput {
  const input = payloadOf(args)
  return {
    serverId: requireString(input.serverId, 'input.serverId'),
    sessionToken: requireString(input.sessionToken, 'input.sessionToken'),
    name: requireString(input.name, 'input.name'),
    arguments: optionalRecord(input.arguments, 'input.arguments'),
    meta: optionalRecord(input.meta, 'input.meta'),
    timeoutMs: optionalUnsignedInteger(input.timeoutMs, 'input.timeoutMs'),
  }
}

export function narrowDisconnectInput(args: Record<string, unknown>): McpDisconnectInput {
  const input = payloadOf(args)
  return {
    serverId: requireString(input.serverId, 'input.serverId'),
    sessionToken: requireString(input.sessionToken, 'input.sessionToken'),
    gracePeriodMs: optionalUnsignedInteger(input.gracePeriodMs, 'input.gracePeriodMs'),
  }
}

/**
 * clientInfo：`name` / `version` 必填且必须是字符串，其余字段原样透传给对端。
 *
 * Rust 那边 `name` / `version` 缺失是 **serde 反序列化失败**（Tauri 层的错误，不是
 * `McpCommandError`），Node 没有那一层，所以这里统一报 `invalid_input`——形状不同但两边都
 * 「在 spawn 之前失败」，不会有一个宿主先把进程拉起来再发现载荷不对。
 */
function narrowImplementationInfo(
  value: unknown,
  field: string,
): McpImplementationInfo | undefined {
  if (value === undefined || value === null) return undefined
  const record = requireRecord(value, field)
  const name = record.name
  const version = record.version
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new McpCommandError(
      'invalid_input',
      `\`${field}\` must carry string \`name\` and \`version\` fields`,
    )
  }
  return normalizeImplementationInfo(record, name, version)
}
