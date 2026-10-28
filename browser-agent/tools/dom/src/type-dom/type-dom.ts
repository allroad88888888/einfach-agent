import type { Tool } from '@einfach-agent/core/tools'
import guide from './type-dom.md?raw'
import { fail, object, target, targetProperties } from '../tool-support'
import type { DomToolsHost } from '../types'

export function createTypeDomTool(host: DomToolsHost): Tool {
  return { name: 'type_dom', runtime: 'browser', replayUnsafe: true, skill: { description: '向已观察文本控件输入文字。', triggers: ['type', 'input', '输入', '搜索'], content: guide }, inputSchema: { type: 'object', properties: { ...targetProperties, text: { type: 'string', maxLength: 10000 } }, required: ['page', 'ref', 'text'], additionalProperties: false }, execution: { mode: 'serial', effectKeys: ['page:write'] }, async execute(args, ctx) { try { const input = object(args); return { ok: true, data: await host.typeDom({ ...target(input), text: input.text as string }, ctx) } } catch (error) { return fail(error) } } }
}
