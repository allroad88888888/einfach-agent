import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { copyPathTool, movePathTool } from './path-operation'

function context(): ToolContext {
  return {
    sessionId: 'session-1',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    copyWorkspacePath: vi.fn().mockResolvedValue({ ok: true, changeSet: { id: 'copy-1', reversible: true } }),
    moveWorkspacePath: vi.fn().mockResolvedValue({ ok: true, changeSet: { id: 'move-1', reversible: true } }),
  }
}

describe('workspace path operation tools', () => {
  it('forwards trimmed copy paths', async () => {
    const ctx = context()
    await copyPathTool.execute({ source: ' src ', destination: ' backup ' }, ctx)
    expect(ctx.copyWorkspacePath).toHaveBeenCalledWith({ source: 'src', destination: 'backup' })
  })

  it('forwards trimmed move paths', async () => {
    const ctx = context()
    await movePathTool.execute({ source: ' old ', destination: ' new ' }, ctx)
    expect(ctx.moveWorkspacePath).toHaveBeenCalledWith({ source: 'old', destination: 'new' })
  })

  it('rejects missing paths', async () => {
    await expect(copyPathTool.execute({ source: 'a' }, context())).resolves.toEqual({
      ok: false,
      error: 'invalid copy_path: source and destination are required',
      code: 'WORKSPACE_PATH_OPERATION_INVALID_INPUT',
      retryable: false,
    })
  })
})
