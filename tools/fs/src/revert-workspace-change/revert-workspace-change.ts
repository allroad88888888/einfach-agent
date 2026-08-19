import type {
  Tool,
  ToolContext,
  WorkspaceRevertInput,
  WorkspaceRevertResult,
} from '@einfach-agent/core/tools'
import guide from './revert-workspace-change.md?raw'

type RevertWorkspaceChange = (
  input: WorkspaceRevertInput,
) => Promise<WorkspaceRevertResult>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function getRevertWorkspaceChange(ctx: ToolContext): RevertWorkspaceChange | undefined {
  const candidate = (ctx as ToolContext & { revertWorkspaceChange?: RevertWorkspaceChange })
    .revertWorkspaceChange
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

export const revertWorkspaceChangeTool: Tool = {
  name: 'revert_workspace_change',
  runtime: 'server',
  replayUnsafe: true,
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
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const input = asRecord(args)
    const changeSetId = typeof input.changeSetId === 'string' ? input.changeSetId.trim() : ''
    const changeSetIds = Array.isArray(input.changeSetIds)
      ? input.changeSetIds.map((id) => typeof id === 'string' ? id.trim() : '')
      : []
    if (!changeSetId && changeSetIds.length === 0) {
      return {
        ok: false,
        error: 'invalid revert_workspace_change: changeSetId or changeSetIds is required',
        code: 'WORKSPACE_REVERT_INVALID_INPUT',
        retryable: false,
      }
    }
    if (changeSetIds.some((id) => !id) || new Set(changeSetIds).size !== changeSetIds.length) {
      return {
        ok: false,
        error: 'invalid revert_workspace_change: changeSetIds must contain unique non-empty strings',
        code: 'WORKSPACE_REVERT_INVALID_INPUT',
        retryable: false,
      }
    }
    if (changeSetId && changeSetIds.length > 0) {
      return {
        ok: false,
        error: 'invalid revert_workspace_change: provide changeSetId or changeSetIds, not both',
        code: 'WORKSPACE_REVERT_INVALID_INPUT',
        retryable: false,
      }
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
      return {
        ok: false,
        error: 'invalid revert_workspace_change: dryRun must be a boolean',
        code: 'WORKSPACE_REVERT_INVALID_INPUT',
        retryable: false,
      }
    }
    const revertWorkspaceChange = getRevertWorkspaceChange(ctx)
    if (!revertWorkspaceChange) {
      return {
        ok: false,
        error: 'revert_workspace_change unavailable: ctx.revertWorkspaceChange is not configured',
        code: 'WORKSPACE_REVERT_UNAVAILABLE',
        retryable: false,
      }
    }
    try {
      const result = await revertWorkspaceChange({
        ...(changeSetId ? { changeSetId } : { changeSetIds }),
        dryRun: input.dryRun === true,
      })
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || `revert_workspace_change failed with status ${result.status}`,
          code: result.status === 'conflict'
            ? 'WORKSPACE_REVERT_CONFLICT'
            : 'WORKSPACE_REVERT_FAILED',
          retryable: false,
          details: result,
        }
      }
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'WORKSPACE_REVERT_FAILED',
        retryable: false,
      }
    }
  },
}
