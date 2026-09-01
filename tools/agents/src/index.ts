// tools-agents —— @einfach-agent/tools-agents：agents 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @einfach-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { delegateAgentTool } from './delegate-agent/delegate-agent'
import { cancelAgentTool } from './cancel-agent/cancel-agent'
import { joinAgentTool } from './join-agent/join-agent'
import { observeAgentTool } from './observe-agent/observe-agent'
import { listAgentHistoriesTool } from './list-agent-histories/list-agent-histories'
import { listAgentHistoryItemsTool } from './list-agent-history-items/list-agent-history-items'
import { readAgentHistoryItemTool } from './read-agent-history-item/read-agent-history-item'
import { searchAgentHistoriesTool } from './search-agent-histories/search-agent-histories'

export {
  cancelAgentTool,
  delegateAgentTool,
  joinAgentTool,
  listAgentHistoriesTool,
  listAgentHistoryItemsTool,
  observeAgentTool,
  readAgentHistoryItemTool,
  searchAgentHistoriesTool,
}

/** 把 agents 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerAgentsTools(registry: ToolRegistry): void {
  for (const tool of [
    delegateAgentTool,
    observeAgentTool,
    joinAgentTool,
    cancelAgentTool,
    listAgentHistoriesTool,
    listAgentHistoryItemsTool,
    readAgentHistoryItemTool,
    searchAgentHistoriesTool,
  ]) {
    registry.register(tool)
  }
}
