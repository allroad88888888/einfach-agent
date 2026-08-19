// tools/mcp/src/connect-mcp-server/connectFailureResult.ts —— 把一次连接失败/超时翻译成模型看到的 ToolResult。
//
// 单一职责：只负责「失败原因 → retryable / code / hint」的翻译，不碰 manager、不做重试调度、
// 不重新判定可重试性——那件事已经由 failureClassification.ts 的 classifyMcpFailure() 做过了
// （F5 的要求就是"由分类器决定，不要自己再写一套判断"）。本文件只是把分类结果转成中文文案
// 和工具协议字段，连接超时是另一条独立分支：超时不经过分类器，因为它不是"连接失败"，
// 只是"这次没等到结果"，天然按可重试处理。
import type { ToolResult } from '@einfach-agent/core/tools'
import {
  classifyMcpFailure,
  type McpFailureClassification,
  type McpFailureReason,
} from '../failureClassification'
import { errorMessage, truncate } from '../internal'
import { MCP_ERROR_MAX_CHARS } from '../toolAdapter'
import type { McpTransport } from '../types'

/**
 * 永久失败（status: 'error'）按 reason 给出具体该做什么，而不是一句「重试吧」。
 * 用 Partial 而不是穷举 Record：failureClassification.ts 未来新增 reason 时，这里静默退回
 * GENERIC_PERMANENT_CONNECT_HINT，不会因为漏了一支分支而编译失败或抛错。
 */
const PERMANENT_CONNECT_HINT: Readonly<Partial<Record<McpFailureReason, string>>> = {
  auth: '身份认证失败，重试不会自愈：请让用户检查该服务的密钥或凭据配置后再连接，不要原样重试。',
  config_invalid: '服务地址或配置无效，重试不会自愈：请让用户检查该服务的配置后再连接，不要原样重试。',
  command_unavailable:
    '启动命令不存在或无法执行，重试不会自愈：请让用户确认该服务的可执行命令与运行环境后再连接，不要原样重试。',
  tool_limit_exceeded: '该服务暴露的工具数量超出限制，重试不会自愈：需要调整服务端或配置后才能连接，不要原样重试。',
  tool_name_collision: '该服务的工具名称与已有工具冲突，重试不会自愈：需要调整服务端或配置后才能连接，不要原样重试。',
  unsupported_capability: '该服务要求的能力当前客户端不支持，重试不会自愈：暂时无法连接此服务，不要原样重试。',
  protocol_violation: '该服务返回的数据不符合协议，重试不会自愈：可能是服务端实现问题，请让用户核实该服务，不要原样重试。',
}
const GENERIC_PERMANENT_CONNECT_HINT =
  '这类失败重试不会自愈：请让用户检查该服务的配置、命令或运行环境后再连接，不要原样重试。'
const TEMPORARY_CONNECT_HINT =
  '连接可能只是网络或传输层的暂时抖动，可以重试；如果反复失败，再检查该服务的配置与运行环境。'

function connectFailureHint(classification: McpFailureClassification): string {
  if (classification.status === 'reconnecting') return TEMPORARY_CONNECT_HINT
  return PERMANENT_CONNECT_HINT[classification.reason] ?? GENERIC_PERMANENT_CONNECT_HINT
}

/**
 * 连接调用本身抛错（非超时）→ ToolResult。
 * retryable 完全等于 `classification.status === 'reconnecting'`——这正是 manager 内部
 * （clientManager.ts connectInternal）落 record.status 时用的同一个分类器、同一个 error，
 * 所以这里算出来的 status 与 manager 快照里的 status 必然一致，不需要另外去读 manager.get()。
 */
export function buildConnectFailureResult(
  serverId: string,
  transport: McpTransport,
  error: unknown,
): ToolResult {
  const classification = classifyMcpFailure(error)
  const retryable = classification.status === 'reconnecting'
  return {
    ok: false,
    error: `连接 MCP 服务「${truncate(serverId, 80)}」失败：`
      + truncate(errorMessage(error), MCP_ERROR_MAX_CHARS),
    code: 'MCP_CONNECT_FAILED',
    retryable,
    hint: connectFailureHint(classification),
    details: {
      serverId,
      transport,
      status: classification.status,
      reason: classification.reason,
    },
  }
}

/**
 * 连接超时（独立于工具调用的 1 小时，见 connect-mcp-server.ts 的 MCP_CONNECT_TIMEOUT_MS）→ ToolResult。
 * 超时不代表配置或环境已经坏了——stdio 服务首次通过 npx 之类的方式冷启动可能还在下载依赖，
 * 所以按可重试处理，而不是走上面的分类器。
 */
export function buildConnectTimeoutResult(
  serverId: string,
  transport: McpTransport,
  timeoutMs: number,
): ToolResult {
  return {
    ok: false,
    error: `连接 MCP 服务「${truncate(serverId, 80)}」超时：超过 ${Math.round(timeoutMs / 1000)} 秒未完成`,
    code: 'MCP_CONNECT_TIMEOUT',
    retryable: true,
    hint: '首次启动可能需要先下载依赖（例如通过 npx），可以稍后重试；如果反复超时，再检查该服务的命令与网络。',
    details: { serverId, transport, timeoutMs },
  }
}
