import type { ToolRegistry } from '@einfach-agent/core/tools'
import { viewImageTool } from './view-image/view-image'

export { viewImageTool }

/** Registers image-observation tools that consume only ToolContext.viewImage. */
export function registerVisionTools(registry: ToolRegistry): void {
  registry.register(viewImageTool)
}
