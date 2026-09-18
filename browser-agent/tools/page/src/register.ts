import type { Tool, ToolRegistry } from '@einfach-agent/core/tools'
import { createFillFieldsTool } from './fill-fields/fill-fields'
import { createReadFormTool } from './read-form/read-form'
import type { PageToolsHost } from './types'
import { createValidateFormTool } from './validate-form/validate-form'
export function createPageTools(host: PageToolsHost): readonly Tool[] { return [createReadFormTool(host), createFillFieldsTool(host), createValidateFormTool(host)] }
export function registerPageTools(registry: ToolRegistry, host: PageToolsHost): void { for (const tool of createPageTools(host)) registry.register(tool) }
