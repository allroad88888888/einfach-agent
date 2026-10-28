import type { Tool } from '@einfach-agent/core/tools'
import guide from './fill-fields.md?raw'
import { fail, object, pageRefSchema, valueSchema, type FillInput } from '../tool-support'
import type { PageToolsHost } from '../types'
export function createFillFieldsTool(host: PageToolsHost): Tool {
  return { name: 'fill_fields', runtime: 'browser', replayUnsafe: true, skill: { description: '批量填写页面字段并回读结果。', triggers: ['form', 'field', '表单', '字段'], content: guide }, inputSchema: { type: 'object', properties: { page: pageRefSchema, values: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: valueSchema }, required: ['id', 'value'], additionalProperties: false } } }, required: ['page', 'values'], additionalProperties: false }, execution: { mode: 'serial', effectKeys: ['page:write'] }, async execute(args, ctx) { try { const input = object(args) as unknown as FillInput; return { ok: true, data: { fields: await host.fillFields({ page: input.page, values: input.values }, ctx) } } } catch (error) { return fail(error) } } }
}
