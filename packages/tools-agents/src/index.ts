// tools-agents —— @web-agent/tools-agents：agents 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @web-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { delegateAgentTool } from './delegate-agent/delegate-agent'

export { delegateAgentTool }

/** 把 agents 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerAgentsTools(registry: ToolRegistry): void {
  for (const tool of [delegateAgentTool]) {
    registry.register(tool)
  }
}
