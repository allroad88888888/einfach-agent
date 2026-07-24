import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import type { WorkspacePatchInput, WorkspacePatchResult } from '@web-agent/core/runtime/workspacePatch'
import { applyPatchTool } from './apply-patch'

type TestToolContext = ToolContext & {
  applyWorkspacePatch: (input: WorkspacePatchInput) => Promise<WorkspacePatchResult>
}

function makeResult(overrides: Partial<WorkspacePatchResult> = {}): WorkspacePatchResult {
  return {
    ok: true,
    changedFiles: [],
    rejected: [],
    dryRun: false,
    wouldChange: false,
    summary: 'ok',
    ...overrides,
  }
}

function makeCtx(
  applyWorkspacePatch = vi.fn(async (input: WorkspacePatchInput) =>
    makeResult({ dryRun: input.dryRun === true }),
  ),
): TestToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    runShell: vi.fn(),
    applyWorkspacePatch,
  }
}

describe('apply_patch tool', () => {
  it('add/replace/delete/overwrite 参数规范化后传给 ctx.applyWorkspacePatch', async () => {
    const patchResult = makeResult({ changedFiles: ['a.txt'], wouldChange: true })
    const applyWorkspacePatch = vi.fn(async () => patchResult)
    const ctx = makeCtx(applyWorkspacePatch)

    const result = await applyPatchTool.execute(
      {
        operations: [
          { type: 'add_file', path: '  a.txt  ', content: 'new' },
          {
            type: 'replace',
            path: 'a.txt',
            oldText: 'new',
            newText: 'newer',
            expectedReplacements: 1,
          },
          { type: 'delete_file', path: 'b.txt', oldContent: 'old' },
          { type: 'overwrite_file', path: 'c.txt', content: 'next', oldContent: 'prev' },
        ],
      },
      ctx,
    )

    expect(applyWorkspacePatch).toHaveBeenCalledWith({
      operations: [
        { type: 'add_file', path: 'a.txt', content: 'new' },
        {
          type: 'replace',
          path: 'a.txt',
          oldText: 'new',
          newText: 'newer',
          expectedReplacements: 1,
        },
        { type: 'delete_file', path: 'b.txt', oldContent: 'old' },
        { type: 'overwrite_file', path: 'c.txt', content: 'next', oldContent: 'prev' },
      ],
    })
    expect(result).toEqual({ ok: true, data: patchResult })
  })

  it('dryRun 透传给 ctx.applyWorkspacePatch', async () => {
    const applyWorkspacePatch = vi.fn(async (input: WorkspacePatchInput) =>
      makeResult({ dryRun: input.dryRun === true }),
    )
    const ctx = makeCtx(applyWorkspacePatch)

    const result = await applyPatchTool.execute(
      { operations: [{ type: 'add_file', path: 'a.txt', content: '' }], dryRun: true },
      ctx,
    )

    expect(applyWorkspacePatch).toHaveBeenCalledWith({
      operations: [{ type: 'add_file', path: 'a.txt', content: '' }],
      dryRun: true,
    })
    expect(result).toEqual({ ok: true, data: makeResult({ dryRun: true }) })
  })

  it('非法 operations → {ok:false} 且不调用 ctx', async () => {
    const applyWorkspacePatch = vi.fn(async () => makeResult())
    const ctx = makeCtx(applyWorkspacePatch)

    await expect(applyPatchTool.execute({}, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid apply_patch: operations (array) is required',
    })
    await expect(
      applyPatchTool.execute({ operations: [{ type: 'replace', path: 'a.txt', oldText: '' }] }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid apply_patch: operations[0].oldText must be a non-empty string',
    })
    await expect(
      applyPatchTool.execute(
        { operations: [{ type: 'replace', path: 'a.txt', oldText: 'a', newText: 'b', expectedReplacements: 0 }] },
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid apply_patch: operations[0].expectedReplacements must be a positive integer',
    })
    expect(applyWorkspacePatch).not.toHaveBeenCalled()
  })

  it('ctx.applyWorkspacePatch 抛错 → {ok:false,error}', async () => {
    const ctx = makeCtx(
      vi.fn(async (_input: WorkspacePatchInput): Promise<WorkspacePatchResult> => {
        throw new Error('boom')
      }),
    )

    const result = await applyPatchTool.execute(
      { operations: [{ type: 'delete_file', path: 'a.txt' }] },
      ctx,
    )

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('ctx 未配置 applyWorkspacePatch → {ok:false,error}', async () => {
    const ctx = {
      sessionId: 's',
      signal: new AbortController().signal,
      progress: vi.fn(),
      callTool: vi.fn(),
      renderCard: vi.fn(),
      saveArtifact: vi.fn(),
      runShell: vi.fn(),
    } satisfies ToolContext

    const result = await applyPatchTool.execute(
      { operations: [{ type: 'delete_file', path: 'a.txt' }] },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: 'apply_patch unavailable: ctx.applyWorkspacePatch is not configured',
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(applyPatchTool.name).toBe('apply_patch')
    expect(applyPatchTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(applyPatchTool.inputSchema).toMatchObject({ required: ['operations'] })
    expect(applyPatchTool.skill.content.length).toBeGreaterThan(0)
  })
})
