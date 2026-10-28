import type { Tool } from '@einfach-agent/core/tools'
import guide from './press-dom-key.md?raw'
import { fail, object, target, targetProperties } from '../tool-support'
import type { DomToolsHost } from '../types'

export function createPressDomKeyTool(host: DomToolsHost): Tool {
  return { name: 'press_dom_key', runtime: 'browser', replayUnsafe: true, skill: { description: '向已观察节点派发键盘事件。', triggers: ['key', 'keyboard', '按键', '回车'], content: guide }, inputSchema: { type: 'object', properties: { ...targetProperties, key: { type: 'string', minLength: 1, maxLength: 50 } }, required: ['page', 'ref', 'key'], additionalProperties: false }, execution: { mode: 'serial', effectKeys: ['page:write'] }, async execute(args, ctx) { try { const input = object(args); return { ok: true, data: await host.pressDomKey({ ...target(input), key: input.key as string }, ctx) } } catch (error) { return fail(error) } } }
}
