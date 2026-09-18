import type { Tool } from '@einfach-agent/core/tools'
import guide from './read-form.md?raw'
import { fail } from '../tool-support'
import type { PageToolsHost } from '../types'
export function createReadFormTool(host: PageToolsHost): Tool {
  return { name: 'read_form', runtime: 'browser', skill: { description: 'Read fields and current values from the bound page form.', triggers: ['form', 'field', '表单', '字段'], content: guide }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(_args, ctx) { try { return { ok: true, data: await host.readForm(ctx) } } catch (error) { return fail(error) } } }
}
