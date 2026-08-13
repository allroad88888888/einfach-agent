import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import { revertWorkspaceChangeTool } from './revert-workspace-change'

function context(revertWorkspaceChange?: ToolContext['revertWorkspaceChange']): ToolContext {
  return {
    sessionId: 'session-1',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    revertWorkspaceChange,
  }
}

describe('revert_workspace_change tool', () => {
  it('validates and forwards a change set id', async () => {
    const revert = vi.fn().mockResolvedValue({
      ok: true,
      status: 'reverted',
      restoredFiles: ['a.txt'],
      conflicts: [],
    })
    const result = await revertWorkspaceChangeTool.execute(
      { changeSetId: ' change-1 ', dryRun: true },
      context(revert),
    )
    expect(revert).toHaveBeenCalledWith({ changeSetId: 'change-1', dryRun: true })
    expect(result).toMatchObject({ ok: true })
  })

  it('rejects missing ids and unavailable runtime capability', async () => {
    await expect(revertWorkspaceChangeTool.execute({}, context())).resolves.toEqual({
      ok: false,
      error: 'invalid revert_workspace_change: changeSetId or changeSetIds is required',
      code: 'WORKSPACE_REVERT_INVALID_INPUT',
      retryable: false,
    })
    await expect(
      revertWorkspaceChangeTool.execute({ changeSetId: 'change-1' }, context()),
    ).resolves.toEqual({
      ok: false,
      error: 'revert_workspace_change unavailable: ctx.revertWorkspaceChange is not configured',
      code: 'WORKSPACE_REVERT_UNAVAILABLE',
      retryable: false,
    })
  })

  it('forwards a batch in original execution order', async () => {
    const revert = vi.fn().mockResolvedValue({
      ok: true,
      status: 'batch_reverted',
      restoredFiles: ['b.txt', 'a.txt'],
      conflicts: [],
    })
    await revertWorkspaceChangeTool.execute(
      { changeSetIds: [' change-1 ', 'change-2'] },
      context(revert),
    )
    expect(revert).toHaveBeenCalledWith({
      changeSetIds: ['change-1', 'change-2'],
      dryRun: false,
    })
  })
})
