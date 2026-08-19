import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { deletePathTool } from './delete-path'

function context(deleteWorkspacePath?: (input: unknown) => Promise<unknown>): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...(deleteWorkspacePath ? { deleteWorkspacePath } : {}),
  } as unknown as ToolContext
}

describe('delete_path tool', () => {
  it('forwards a validated recoverable deletion', async () => {
    const remove = vi.fn(async () => ({
      ok: true,
      path: 'build',
      deleted: true,
      reversible: true,
      changeSet: { id: 'change-1', reversible: true },
    }))
    await expect(
      deletePathTool.execute({ path: ' build ', recursive: true }, context(remove)),
    ).resolves.toMatchObject({ ok: true, data: { reversible: true } })
    expect(remove).toHaveBeenCalledWith({ path: 'build', recursive: true })
  })

  it('rejects invalid arguments and missing runtime capability', async () => {
    await expect(deletePathTool.execute({}, context())).resolves.toEqual({
      ok: false,
      error: 'invalid delete_path: path is required',
      code: 'WORKSPACE_DELETE_INVALID_INPUT',
      retryable: false,
    })
    await expect(deletePathTool.execute({ path: 'a.txt' }, context())).resolves.toEqual({
      ok: false,
      error: 'delete_path unavailable: ctx.deleteWorkspacePath is not configured',
      code: 'WORKSPACE_DELETE_UNAVAILABLE',
      retryable: false,
    })
  })
})
