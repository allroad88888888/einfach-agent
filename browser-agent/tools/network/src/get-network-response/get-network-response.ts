import type { Tool } from '@einfach-agent/core/tools'
import { requestSchema } from '../tool-schemas'
import { context, toolError } from '../tool-support'
import type { NetworkToolsHost, RequestInput } from '../types'
import guide from './get-network-response.md?raw'

export function createGetNetworkResponseTool(host: NetworkToolsHost): Tool {
  return {
    name: 'get_network_response', runtime: 'browser', execution: { mode: 'parallel' },
    skill: { description: '读取单个页面请求的脱敏响应状态、允许的响应头和安全正文。', triggers: ['network', 'response', 'body', '响应正文'], content: guide },
    inputSchema: requestSchema,
    async execute(args, ctx) {
      try { return { ok: true, data: await host.getResponse(args as RequestInput, context(ctx)) } }
      catch (error) { return toolError(error) }
    },
  }
}
