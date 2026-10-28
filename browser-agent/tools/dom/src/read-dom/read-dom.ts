import type { Tool } from '@einfach-agent/core/tools'
import guide from './read-dom.md?raw'
import { fail, object, readProperties } from '../tool-support'
import type { DomToolsHost, ReadDomInput } from '../types'

export function createReadDomTool(host: DomToolsHost): Tool {
  return { name: 'read_dom', runtime: 'browser', skill: { description: '读取当前页面可见DOM节点与稳定引用。', triggers: ['DOM', 'element', '元素', '页面控件'], content: guide }, inputSchema: { type: 'object', properties: readProperties, additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(args, ctx) { try { return { ok: true, data: await host.readDom(object(args) as ReadDomInput, ctx) } } catch (error) { return fail(error) } } }
}
