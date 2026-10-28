import type { Tool } from '@einfach-agent/core/tools'
import guide from './validate-form.md?raw'
import { fail, object, pageRefSchema } from '../tool-support'
import type { PageRef, PageToolsHost } from '../types'
export function createValidateFormTool(host: PageToolsHost): Tool {
  return { name: 'validate_form', runtime: 'browser', skill: { description: '校验页面字段且不提交表单。', triggers: ['form', 'validate', '表单', '校验'], content: guide }, inputSchema: { type: 'object', properties: { page: pageRefSchema, fieldIds: { type: 'array', items: { type: 'string' } } }, required: ['page'], additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(args, ctx) { try { const input = object(args); return { ok: true, data: { fields: await host.validateForm({ page: input.page as PageRef, fieldIds: input.fieldIds as string[] | undefined }, ctx) } } } catch (error) { return fail(error) } } }
}
