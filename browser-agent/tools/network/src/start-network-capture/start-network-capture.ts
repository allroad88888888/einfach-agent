import type { Tool } from '@einfach-agent/core/tools'
import type { NetworkCaptureOptions, NetworkToolsHost } from '../types'
import { context, toolError } from '../tool-support'
import guide from './start-network-capture.md?raw'
export function createStartNetworkCaptureTool(host: NetworkToolsHost): Tool {
  return {
    name: 'start_network_capture',
    runtime: 'browser',
    execution: { mode: 'serial', effectKeys: ['network:capture'] },
    skill: {
      description: '为插件加载时已开始的页面请求监听创建独立过滤 capture 视图；无需过滤时可直接列出自动记录。',
      triggers: ['network', 'request', 'capture', '网络', '请求'],
      content: guide,
    },
    inputSchema: {
      type: 'object',
      properties: {
        urlIncludes: { type: 'string', minLength: 1, maxLength: 500 },
        methods: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 20 } },
        includeBuffered: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      try {
        return { ok: true, data: await host.startCapture(args as NetworkCaptureOptions, context(ctx)) }
      } catch (error) {
        return toolError(error)
      }
    },
  }
}
