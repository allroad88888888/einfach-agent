import type { Tool } from '@einfach-agent/core/tools'
import guide from './click-dom.md?raw'
import { fail, object, target, targetProperties } from '../tool-support'
import type { DomToolsHost } from '../types'

export function createClickDomTool(host: DomToolsHost): Tool {
  return { name: 'click_dom', runtime: 'browser', replayUnsafe: true, skill: { description: '点击已观察的精确DOM节点。', triggers: ['click', '点击', '展开', '选择'], content: guide }, inputSchema: { type: 'object', properties: targetProperties, required: ['page', 'ref'], additionalProperties: false }, execution: { mode: 'serial', effectKeys: ['page:write'] }, async execute(args, ctx) { try { return { ok: true, data: await host.clickDom(target(object(args)), ctx) } } catch (error) { return fail(error) } } }
}
