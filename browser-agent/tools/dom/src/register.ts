import type { Tool, ToolRegistry } from '@einfach-agent/core/tools'
import { createClickDomTool } from './click-dom/click-dom'
import { createPressDomKeyTool } from './press-dom-key/press-dom-key'
import { createReadDomTool } from './read-dom/read-dom'
import { createScrollDomTool } from './scroll-dom/scroll-dom'
import { createTypeDomTool } from './type-dom/type-dom'
import type { DomToolsHost } from './types'
import { createWaitForDomTool } from './wait-for-dom/wait-for-dom'

export function createDomTools(host: DomToolsHost): readonly Tool[] {
  return [createReadDomTool(host), createClickDomTool(host), createTypeDomTool(host), createPressDomKeyTool(host), createScrollDomTool(host), createWaitForDomTool(host)]
}
export function registerDomTools(registry: ToolRegistry, host: DomToolsHost): void { for (const tool of createDomTools(host)) registry.register(tool) }
