import type { Tool } from '@einfach-agent/core/tools'
import guide from './scroll-dom.md?raw'
import { fail, object, target, targetProperties } from '../tool-support'
import type { DomToolsHost, ScrollDomInput } from '../types'

export function createScrollDomTool(host: DomToolsHost): Tool {
  return { name: 'scroll_dom', runtime: 'browser', replayUnsafe: true, skill: { description: '滚动已观察DOM节点。', triggers: ['scroll', '滚动', '更多内容'], content: guide }, inputSchema: { type: 'object', properties: { ...targetProperties, direction: { enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 10000 } }, required: ['page', 'ref', 'direction'], additionalProperties: false }, execution: { mode: 'serial', effectKeys: ['page:write'] }, async execute(args, ctx) { try { const input = object(args); return { ok: true, data: await host.scrollDom({ ...target(input), direction: input.direction, amount: input.amount } as ScrollDomInput, ctx) } } catch (error) { return fail(error) } } }
}
