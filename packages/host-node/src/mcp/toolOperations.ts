// tools/list 的翻页与 tools/call 的一次调用
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_manager.rs 的 `list_tools` / `call_tool`。
//
// 这两段是 `mcp_list_tools` / `mcp_call_tool` 两条命令的**定义本身**——命令返回的就是
// 「翻完页的工具全集」和「一次工具调用的结果」，没有更薄的实现形态。真正属于协议编排、
// 且**已经在 tools/mcp 里**的那些（工具适配、schema 校验、命名冲突对账、重连退避、保活）
// 一律不在这里，本文件对工具的语义一无所知：它只认 JSON-RPC 的 method 名和分页游标。

import { McpCommandError } from './errors'
import type { McpCallToolInput, McpListToolsInput } from './inputs'
import { DEFAULT_MAX_TOOL_PAGES, MAX_TOOL_PAGES, MAX_TOTAL_TOOLS } from './limits'
import {
  narrowToolCallPayload,
  narrowToolPage,
  type McpListToolsResult,
  type McpTool,
} from './results'
import type { McpSession } from './session'

export async function listTools(
  session: McpSession,
  input: McpListToolsInput,
): Promise<McpListToolsResult> {
  const serverId = session.serverId
  const timeoutMs = session.resolveTimeout(input.timeoutMs, 'timeoutMs')
  const allPages = input.allPages ?? true
  const maxPages = resolveMaxPages(input.maxPages, serverId)

  // 超时是**整趟翻页共享一个预算**，不是每页各给一份：一台每页回得都很快、但游标永不结束的
  // server，按页计时能把我们钉在这里跑满 maxPages 页。用单调时钟（`performance.now`，对齐
  // Rust 的 `Instant`）而不是 `Date.now`——系统时间被 NTP 往回拨一下就会把超时变成负数。
  const startedAt = performance.now()
  let cursor = input.cursor
  const seenCursors = new Set<string>()
  if (cursor !== undefined) seenCursors.add(cursor)
  const tools: McpTool[] = []
  let pagesFetched = 0

  for (;;) {
    const remaining = timeoutMs - (performance.now() - startedAt)
    if (remaining < 0) {
      throw new McpCommandError(
        'timeout',
        `MCP tools/list timed out after ${timeoutMs} ms`,
      ).forServer(serverId)
    }

    const params = cursor === undefined ? {} : { cursor }
    const page = narrowToolPage(await session.request('tools/list', params, remaining), serverId)
    pagesFetched += 1

    // 累计上限判在 **push 之前**：判在之后的话，一台恶意 server 靠一页就能让我们先把 10 万个
    // 工具收进内存再说「超限了」。
    if (page.tools.length > Math.max(0, MAX_TOTAL_TOOLS - tools.length)) {
      throw new McpCommandError(
        'protocol_error',
        `tools/list exceeded the ${MAX_TOTAL_TOOLS}-tool safety limit (received at least ${tools.length + page.tools.length})`,
      ).forServer(serverId)
    }
    tools.push(...page.tools)

    // 空串游标当没有下一页。协议里 `nextCursor: ""` 是畸形的，但把它当成一个真游标会让
    // 下一轮带着空游标再问一次，而对端多半原样再回一个空串——一个不报错的死循环。
    const nextCursor = page.nextCursor !== undefined && page.nextCursor.length > 0
      ? page.nextCursor
      : undefined
    if (nextCursor === undefined) {
      return { serverId, tools, pagesFetched, truncated: false }
    }
    if (!allPages || pagesFetched >= maxPages) {
      return { serverId, tools, nextCursor, pagesFetched, truncated: true }
    }
    // 游标重复 = 对端在原地打转。不判的话这个循环只会被超时或工具数上限终止，而那两条都要
    // 先把大量请求打出去。判为 protocol_error（永久失败）是对的：重连不会让它学会翻页。
    if (seenCursors.has(nextCursor)) {
      throw new McpCommandError(
        'protocol_error',
        `tools/list returned the repeated cursor \`${nextCursor}\``,
      ).forServer(serverId)
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

function resolveMaxPages(requested: number | undefined, serverId: string): number {
  if (requested === undefined) return DEFAULT_MAX_TOOL_PAGES
  if (requested === 0) {
    throw new McpCommandError(
      'invalid_input',
      'maxPages must be greater than zero',
    ).forServer(serverId)
  }
  return Math.min(requested, MAX_TOOL_PAGES)
}

/**
 * 调一次工具。`toolName` 由调用方**先归一化好再传进来**——Rust 的 `call_tool` 在查会话之前
 * 就校验了它，两者顺序不能反：一个既拼错了工具名、服务又没连上的调用，两个宿主必须报同一个
 * 错（`invalid_input`，不是 `not_connected`），否则模型会照着不同的提示走两条不同的自救路径。
 */
export async function callTool(
  session: McpSession,
  input: McpCallToolInput,
  toolName: string,
): Promise<Record<string, unknown>> {
  const serverId = session.serverId
  const timeoutMs = session.resolveTimeout(input.timeoutMs, 'timeoutMs')

  const params: Record<string, unknown> = {
    name: toolName,
    // 缺省是**空对象而不是省略**：MCP 的 `tools/call` 要求 `arguments` 存在，省略会让一部分
    // 严格实现直接报参数错误。Rust 那边是 `unwrap_or_default()`，同一件事。
    arguments: input.arguments ?? {},
    ...(input.meta === undefined ? {} : { _meta: input.meta }),
  }

  const payload = narrowToolCallPayload(
    await session.request('tools/call', params, timeoutMs),
    serverId,
  )
  // Rust 的 `McpCallToolResult` 是 `serverId` + `toolName` + `#[serde(flatten)] result`，
  // 所以线上形状是**平铺**的：`{ serverId, toolName, content, isError, ... }`。
  return { serverId, toolName, ...payload }
}
