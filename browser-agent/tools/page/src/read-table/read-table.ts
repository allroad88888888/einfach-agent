import type { Tool } from '@einfach-agent/core/tools'
import guide from './read-table.md?raw'
import { limitSchema, numberPageSchema } from '../field-tool-support'
import { fail, object, pageRefSchema } from '../tool-support'
import type { PageToolsHost, ReadTableInput } from '../types'
export function createReadTableTool(host: PageToolsHost): Tool {
  if (!host.readTable) throw new Error('read_table requires host.readTable')
  return { name: 'read_table', runtime: 'browser', skill: { description: '分页读取页面中的语义表格。', triggers: ['表格', '行列', 'table'], content: guide }, inputSchema: { type: 'object', properties: { page: pageRefSchema, tableId: { type: 'string', minLength: 1 }, offset: numberPageSchema, limit: limitSchema }, required: ['page', 'tableId'], additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(args, ctx) { try { return { ok: true, data: await host.readTable!(object(args) as unknown as ReadTableInput, ctx) } } catch (error) { return fail(error) } } }
}
