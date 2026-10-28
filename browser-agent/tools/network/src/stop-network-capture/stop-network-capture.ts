import type { Tool } from '@einfach-agent/core/tools'
import { captureSchema } from '../tool-schemas'
import { context, toolError } from '../tool-support'
import type { CaptureInput, NetworkToolsHost } from '../types'
import guide from './stop-network-capture.md?raw'

export function createStopNetworkCaptureTool(host: NetworkToolsHost): Tool {
  return {
    name: 'stop_network_capture', runtime: 'browser', execution: { mode: 'serial', effectKeys: ['network:capture'] },
    skill: { description: '停止当前会话的页面请求捕获并保留已有记录供读取。', triggers: ['network', 'stop', 'capture', '停止捕获'], content: guide },
    inputSchema: captureSchema,
    async execute(args, ctx) {
      try { return { ok: true, data: await host.stopCapture(args as CaptureInput, context(ctx)) } }
      catch (error) { return toolError(error) }
    },
  }
}
