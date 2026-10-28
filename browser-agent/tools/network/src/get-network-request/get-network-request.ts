import type { Tool } from '@einfach-agent/core/tools'
import { requestSchema } from '../tool-schemas'
import { context, toolError } from '../tool-support'
import type { NetworkToolsHost, RequestInput } from '../types'
import guide from './get-network-request.md?raw'

export function createGetNetworkRequestTool(host: NetworkToolsHost): Tool {
  return {
    name: 'get_network_request', runtime: 'browser', execution: { mode: 'parallel' },
    skill: { description: '读取单个页面请求的脱敏 URL、允许的请求头和安全正文。', triggers: ['network', 'request', 'details', '请求详情'], content: guide },
    inputSchema: requestSchema,
    async execute(args, ctx) {
      try { return { ok: true, data: await host.getRequest(args as RequestInput, context(ctx)) } }
      catch (error) { return toolError(error) }
    },
  }
}
