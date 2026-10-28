import type { Tool } from '@einfach-agent/core/tools'
import { captureId } from '../tool-schemas'
import { context, toolError } from '../tool-support'
import type { NetworkListInput, NetworkToolsHost } from '../types'
import guide from './list-network-requests.md?raw'

export function createListNetworkRequestsTool(host: NetworkToolsHost): Tool {
  return {
    name: 'list_network_requests', runtime: 'browser', execution: { mode: 'parallel' },
    skill: { description: '分页列出页面请求；可省略 captureId 直接读取插件加载后自动记录的请求，无需先 start。', triggers: ['network', 'requests', 'list', '请求列表'], content: guide },
    inputSchema: { type: 'object', properties: { captureId, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, urlIncludes: { type: 'string', minLength: 1, maxLength: 500 }, method: { type: 'string', minLength: 1, maxLength: 20 } }, additionalProperties: false },
    async execute(args, ctx) {
      try { return { ok: true, data: await host.listRequests(args as NetworkListInput, context(ctx)) } }
      catch (error) { return toolError(error) }
    },
  }
}
