import type { Tool } from '@einfach-agent/core/tools'
import guide from './read-page.md?raw'
import { fail, object } from '../tool-support'
import type { PageToolsHost } from '../types'
export function createReadPageTool(host: PageToolsHost): Tool {
  if (!host.readPage) throw new Error('read_page requires host.readPage')
  return { name: 'read_page', runtime: 'browser', skill: { description: '读取当前页面的标题、正文和表格清单。', triggers: ['页面', '正文', '表格', 'page'], content: guide }, inputSchema: { type: 'object', properties: { maxChars: { type: 'integer', minimum: 1, maximum: 20_000 } }, additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(args, ctx) { try { return { ok: true, data: await host.readPage!(object(args), ctx) } } catch (error) { return fail(error) } } }
}
