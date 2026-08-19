import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { WorkspacePatchInput, WorkspacePatchResult } from '@einfach-agent/core/runtime/workspacePatch'
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

  it('expectedContentHash 与 write_file 同名同格式，可替代 oldContent 全文', async () => {
    // 以前覆盖已存在文件只能靠 oldContent 全文比对，等于每次都把整个旧文件塞进参数。
    const applyWorkspacePatch = vi.fn(async () => makeResult())
    const ctx = makeCtx(applyWorkspacePatch)
    const expectedContentHash = `sha256:${'a'.repeat(64)}`

    await applyPatchTool.execute(
      {
        operations: [
          { type: 'overwrite_file', path: 'c.txt', content: 'next', expectedContentHash },
          { type: 'delete_file', path: 'd.txt', expectedContentHash },
        ],
      },
      ctx,
    )

    expect(applyWorkspacePatch).toHaveBeenCalledWith({
      operations: [
        { type: 'overwrite_file', path: 'c.txt', content: 'next', expectedContentHash },
        { type: 'delete_file', path: 'd.txt', expectedContentHash },
      ],
    })
  })

  it('executable 透传，false 也必须透传', async () => {
    const applyWorkspacePatch = vi.fn(async () => makeResult())
    const ctx = makeCtx(applyWorkspacePatch)

    await applyPatchTool.execute(
      {
        operations: [
          { type: 'add_file', path: 'run.sh', content: '#!/bin/sh\n', executable: true },
          { type: 'overwrite_file', path: 'old.sh', content: 'x', oldContent: 'y', executable: false },
        ],
      },
      ctx,
    )

    expect(applyWorkspacePatch).toHaveBeenCalledWith({
      operations: [
        { type: 'add_file', path: 'run.sh', content: '#!/bin/sh\n', executable: true },
        { type: 'overwrite_file', path: 'old.sh', content: 'x', oldContent: 'y', executable: false },
      ],
    })
  })

  it('两种 guard 不能同时给，非法 hash / executable 直接拒', async () => {
    const applyWorkspacePatch = vi.fn(async () => makeResult())
    const ctx = makeCtx(applyWorkspacePatch)
    const expectedContentHash = `sha256:${'a'.repeat(64)}`

    await expect(
      applyPatchTool.execute(
        {
          operations: [
            { type: 'overwrite_file', path: 'c.txt', content: 'n', oldContent: 'o', expectedContentHash },
          ],
        },
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'invalid apply_patch: operations[0] must pass either oldContent or expectedContentHash, not both',
    })

    await expect(
      applyPatchTool.execute(
        {
          operations: [
            { type: 'overwrite_file', path: 'c.txt', content: 'n', expectedContentHash: 'sha256:nope' },
          ],
        },
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'invalid apply_patch: operations[0].expectedContentHash must use sha256:<64 lowercase hex characters>',
    })

    await expect(
      applyPatchTool.execute(
        { operations: [{ type: 'add_file', path: 'a.txt', content: 'x', executable: 'yes' }] },
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid apply_patch: operations[0].executable must be a boolean',
    })

    expect(applyWorkspacePatch).not.toHaveBeenCalled()
  })

  it('每文件 changeSummary 原样回传给模型', async () => {
    const patchResult = makeResult({
      changedFiles: ['a.txt'],
      wouldChange: true,
      changes: [
        {
          path: 'a.txt',
          created: false,
          deleted: false,
          changeSummary: {
            linesAdded: 1,
            linesRemoved: 1,
            beforeLines: 2,
            afterLines: 2,
            diff: '@@ -2,1 +2,1 @@\n-old\n+new',
            diffTruncated: false,
            approximate: false,
          },
        },
      ],
    })
    const ctx = makeCtx(vi.fn(async () => patchResult))

    const result = await applyPatchTool.execute(
      { operations: [{ type: 'overwrite_file', path: 'a.txt', content: 'x', oldContent: 'y' }] },
      ctx,
    )

    expect(result).toEqual({ ok: true, data: patchResult })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(applyPatchTool.name).toBe('apply_patch')
    expect(applyPatchTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(applyPatchTool.inputSchema).toMatchObject({ required: ['operations'] })
    expect(applyPatchTool.skill.content.length).toBeGreaterThan(0)
  })
})
