import type { ToolRegistry } from '@einfach-agent/core/tools'
import { deepseekSearchTool } from './deepseek-search/deepseek-search'

export { deepseekSearchTool }
export { createDeepSeekSearch } from './deepseekSearch'

export function registerSearchTools(registry: ToolRegistry): void {
  registry.register(deepseekSearchTool)
}
