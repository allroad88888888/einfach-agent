import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import guide from './delete-path.md?raw'

type DeleteWorkspacePathResult = {
  ok: boolean
  path: string
  deleted: boolean
  reversible: boolean
  error?: string
  changeSet?: { id: string; reversible: boolean }
}

type DeleteWorkspacePath = (
  input: { path: string; recursive?: boolean },
) => Promise<DeleteWorkspacePathResult>

function getDeleteWorkspacePath(ctx: ToolContext): DeleteWorkspacePath | undefined {
  const candidate = (ctx as ToolContext & { deleteWorkspacePath?: DeleteWorkspacePath })
    .deleteWorkspacePath
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

export const deletePathTool: Tool = {
  name: 'delete_path',
  runtime: 'server',
  skill: {
    description: '可撤回地删除当前 workspace 内的文件或目录；删除时应优先使用本工具而不是 shell rm。',
    triggers: ['delete', 'remove', 'rm', '删除文件', '删除目录', '撤回删除'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean', default: false },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {}
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    const recursive = input.recursive === undefined ? false : input.recursive
    if (!path) {
      return {
        ok: false,
        error: 'invalid delete_path: path is required',
        code: 'WORKSPACE_DELETE_INVALID_INPUT',
        retryable: false,
      }
    }
    if (typeof recursive !== 'boolean') {
      return {
        ok: false,
        error: 'invalid delete_path: recursive must be a boolean',
        code: 'WORKSPACE_DELETE_INVALID_INPUT',
        retryable: false,
      }
    }
    const deleteWorkspacePath = getDeleteWorkspacePath(ctx)
    if (!deleteWorkspacePath) {
      return {
        ok: false,
        error: 'delete_path unavailable: ctx.deleteWorkspacePath is not configured',
        code: 'WORKSPACE_DELETE_UNAVAILABLE',
        retryable: false,
      }
    }
    try {
      const result = await deleteWorkspacePath({ path, recursive })
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || `delete_path failed: ${path}`,
          code: 'WORKSPACE_DELETE_FAILED',
          retryable: false,
          details: result,
        }
      }
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        error: `delete_path failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'WORKSPACE_DELETE_FAILED',
        retryable: false,
      }
    }
  },
}
