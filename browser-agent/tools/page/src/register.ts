import type { Tool, ToolRegistry } from '@einfach-agent/core/tools'
import { createFillFieldsTool } from './fill-fields/fill-fields'
import { createReadFormTool } from './read-form/read-form'
import type { PageToolsHost } from './types'
import { createValidateFormTool } from './validate-form/validate-form'
import { createReadPageTool } from './read-page/read-page'
import { createReadTableTool } from './read-table/read-table'
import { createReadFieldOptionsTool } from './read-field-options/read-field-options'
import { createWaitForFieldTool } from './wait-for-field/wait-for-field'
import { createSelectOptionTool } from './select-option/select-option'
import { createClearFieldsTool } from './clear-fields/clear-fields'
export function createPageTools(host: PageToolsHost): readonly Tool[] {
  const tools = [createReadFormTool(host), createFillFieldsTool(host), createValidateFormTool(host), createReadFieldOptionsTool(host), createWaitForFieldTool(host), createSelectOptionTool(host), createClearFieldsTool(host)]
  if (host.readPage) tools.unshift(createReadPageTool(host))
  if (host.readTable) tools.splice(host.readPage ? 1 : 0, 0, createReadTableTool(host))
  return tools
}
export function registerPageTools(registry: ToolRegistry, host: PageToolsHost): void { for (const tool of createPageTools(host)) registry.register(tool) }
