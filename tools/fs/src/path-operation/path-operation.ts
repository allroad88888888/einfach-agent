import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import guide from './path-operation.md?raw'

type Operation = 'copy' | 'move'

function createPathOperationTool(operation: Operation): Tool {
  const name = `${operation}_path`
  return {
    name,
    runtime: 'server',
    replayUnsafe: true,
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
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const input = args && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {}
      const source = typeof input.source === 'string' ? input.source.trim() : ''
      const destination = typeof input.destination === 'string' ? input.destination.trim() : ''
      if (!source || !destination) {
        return {
          ok: false,
          error: `invalid ${name}: source and destination are required`,
          code: 'WORKSPACE_PATH_OPERATION_INVALID_INPUT',
          retryable: false,
        }
      }
      const method = operation === 'copy' ? ctx.copyWorkspacePath : ctx.moveWorkspacePath
      if (typeof method !== 'function') {
        return {
          ok: false,
          error: `${name} unavailable: workspace path operations are not configured`,
          code: 'WORKSPACE_PATH_OPERATION_UNAVAILABLE',
          retryable: false,
        }
      }
      try {
        const result = await method.call(ctx, { source, destination })
        if (
          result
          && typeof result === 'object'
          && !Array.isArray(result)
          && (result as { ok?: unknown }).ok === false
        ) {
          const error = (result as { error?: unknown }).error
          return {
            ok: false,
            error: typeof error === 'string' && error ? error : `${name} failed`,
            code: 'WORKSPACE_PATH_OPERATION_FAILED',
            retryable: false,
            details: result,
          }
        }
        return { ok: true, data: result }
      } catch (error) {
        return {
          ok: false,
          error: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'WORKSPACE_PATH_OPERATION_FAILED',
          retryable: false,
        }
      }
    },
  }
}

export const copyPathTool = createPathOperationTool('copy')
export const movePathTool = createPathOperationTool('move')
