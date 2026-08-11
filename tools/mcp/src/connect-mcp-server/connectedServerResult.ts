// tools/mcp/src/connect-mcp-server/connectedServerResult.ts —— 把一次【成功】连接后的服务快照
// 翻译成回给模型的 data。与 connectFailureResult.ts 完全对称：失败的翻译早就独立成文件了，
// 成功的翻译没有理由留在主流程里跟连接编排、超时、取消挤在一起。
//
// 这里的清单和 lastKnownToolsText.ts 的清单是两回事，不要混：本文件给的是【此刻的事实】——
// 这些工具刚刚注册进 ToolRegistry，模型下一轮就能直接调用；那边给的是「上次已知」的历史。
import { truncate } from '../internal'
import type { McpServerSnapshot } from '../types'

/** 回给模型的工具清单条数上限（单个服务最多可有 1000 个工具，全列会撑爆上下文）。 */
export const MCP_CONNECT_MAX_LISTED_TOOLS = 50
export const MCP_CONNECT_LISTED_DESCRIPTION_MAX_CHARS = 160

export function describeConnectedServer(
  snapshot: McpServerSnapshot,
  alreadyConnected: boolean,
): Record<string, unknown> {
  const listed = snapshot.tools.slice(0, MCP_CONNECT_MAX_LISTED_TOOLS)
  const omitted = snapshot.tools.length - listed.length
  return {
    serverId: snapshot.id,
    // 只暴露 transport，绝不回传 snapshot.config —— 里面有 url / headers / env，可能含凭据。
    transport: snapshot.config.transport,
    status: snapshot.status,
    alreadyConnected,
    toolCount: snapshot.tools.length,
    tools: listed.map((tool) => ({
      name: tool.name,
      description: truncate(tool.description, MCP_CONNECT_LISTED_DESCRIPTION_MAX_CHARS),
    })),
    ...(omitted > 0 ? { omittedTools: omitted } : {}),
  }
}
