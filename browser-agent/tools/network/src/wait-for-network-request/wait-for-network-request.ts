import type { Tool } from '@einfach-agent/core/tools'
import { captureId } from '../tool-schemas'
import { context, toolError } from '../tool-support'
import type { NetworkToolsHost, NetworkWaitInput } from '../types'
import guide from './wait-for-network-request.md?raw'

export function createWaitForNetworkRequestTool(host: NetworkToolsHost): Tool {
  return {
    name: 'wait_for_network_request', runtime: 'browser', execution: { mode: 'parallel' },
    skill: { description: '等待匹配的页面请求开始或完成，不取消页面自己的请求。', triggers: ['network', 'wait', 'request', '等待请求'], content: guide },
    inputSchema: { type: 'object', properties: { captureId, urlIncludes: { type: 'string', minLength: 1, maxLength: 500 }, method: { type: 'string', minLength: 1, maxLength: 20 }, state: { type: 'string', enum: ['started', 'finished'] }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, required: ['captureId'], additionalProperties: false },
    async execute(args, ctx) {
      try { return { ok: true, data: await host.waitForRequest(args as NetworkWaitInput, context(ctx)) } }
      catch (error) { return toolError(error) }
    },
  }
}
