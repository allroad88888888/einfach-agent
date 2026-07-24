import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import type {
  WorkspaceRevertInput,
  WorkspaceRevertResult,
} from '@web-agent/core/runtime/workspaceChange'
import guide from './revert-workspace-change.md?raw'

type RevertContext = ToolContext & {
  revertWorkspaceChange(input: WorkspaceRevertInput): Promise<WorkspaceRevertResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hasRevert(ctx: ToolContext): ctx is RevertContext {
  return typeof ctx.revertWorkspaceChange === 'function'
}

export const revertWorkspaceChangeTool: Tool = {
  name: 'revert_workspace_change',
  runtime: 'server',
  skill: {
    description: '安全回退一个或一批 workspace changeSet；批量输入按执行顺序传入并以逆序原子回退。',
    triggers: ['revert', 'rollback', 'undo', '回退', '撤销文件'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      changeSetId: { type: 'string' },
      changeSetIds: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string' },
        description: 'ChangeSet IDs in original execution order. They are reverted in reverse order.',
      },
      dryRun: { type: 'boolean', default: false },
    },
    anyOf: [{ required: ['changeSetId'] }, { required: ['changeSetIds'] }],
  },
  async execute(args, ctx) {
    const input = asRecord(args)
    const changeSetId = typeof input.changeSetId === 'string' ? input.changeSetId.trim() : ''
    const changeSetIds = Array.isArray(input.changeSetIds)
      ? input.changeSetIds.map((id) => typeof id === 'string' ? id.trim() : '')
      : []
    if (!changeSetId && changeSetIds.length === 0) {
      return { ok: false, error: 'invalid revert_workspace_change: changeSetId or changeSetIds is required' }
    }
    if (changeSetIds.some((id) => !id) || new Set(changeSetIds).size !== changeSetIds.length) {
      return { ok: false, error: 'invalid revert_workspace_change: changeSetIds must contain unique non-empty strings' }
    }
    if (changeSetId && changeSetIds.length > 0) {
      return { ok: false, error: 'invalid revert_workspace_change: provide changeSetId or changeSetIds, not both' }
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
      return { ok: false, error: 'invalid revert_workspace_change: dryRun must be a boolean' }
    }
    if (!hasRevert(ctx)) {
      return {
        ok: false,
        error: 'revert_workspace_change unavailable: ctx.revertWorkspaceChange is not configured',
      }
    }
    try {
      const result = await ctx.revertWorkspaceChange({
        ...(changeSetId ? { changeSetId } : { changeSetIds }),
        dryRun: input.dryRun === true,
      })
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
