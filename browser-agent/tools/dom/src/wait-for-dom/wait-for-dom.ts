import type { Tool } from '@einfach-agent/core/tools'
import guide from './wait-for-dom.md?raw'
import { fail, object, readProperties } from '../tool-support'
import type { DomToolsHost, WaitForDomInput } from '../types'

export function createWaitForDomTool(host: DomToolsHost): Tool {
  return { name: 'wait_for_dom', runtime: 'browser', skill: { description: '等待DOM节点出现或消失。', triggers: ['wait', '等待', '出现', '消失'], content: guide }, inputSchema: { type: 'object', properties: { ...readProperties, condition: { enum: ['present', 'absent'] }, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }, required: ['page'], additionalProperties: false }, execution: { mode: 'parallel', effectKeys: ['page:read'] }, async execute(args, ctx) { try { return { ok: true, data: await host.waitForDom(object(args) as unknown as WaitForDomInput, ctx) } } catch (error) { return fail(error) } } }
}
