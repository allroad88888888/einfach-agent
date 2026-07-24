import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import guide from './path-operation.md?raw'

type Operation = 'copy' | 'move'

function createPathOperationTool(operation: Operation): Tool {
  const name = `${operation}_path`
  return {
    name,
    runtime: 'server',
    skill: {
      description: `${operation === 'copy' ? '复制' : '移动'} workspace 内文件或目录，并返回可撤回的 changeSet。`,
      triggers: [operation, name, operation === 'copy' ? '复制路径' : '移动路径'],
      content: guide,
    },
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
    },
    async execute(args, ctx) {
      const input = args && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {}
      const source = typeof input.source === 'string' ? input.source.trim() : ''
      const destination = typeof input.destination === 'string' ? input.destination.trim() : ''
      if (!source || !destination) {
        return { ok: false, error: `invalid ${name}: source and destination are required` }
      }
      const method = operation === 'copy' ? ctx.copyWorkspacePath : ctx.moveWorkspacePath
      if (typeof method !== 'function') {
        return { ok: false, error: `${name} unavailable: workspace path operations are not configured` }
      }
      try {
        return { ok: true, data: await method.call(ctx, { source, destination }) }
      } catch (error) {
        return { ok: false, error: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

export const copyPathTool = createPathOperationTool('copy')
export const movePathTool = createPathOperationTool('move')
