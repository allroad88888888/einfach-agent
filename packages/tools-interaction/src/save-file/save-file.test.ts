// save-file.test.ts —— 副作用工具单测（TOOLS-SPEC §11）。
// 隔离红利：不需要 store，只 mock 一个 ctx，saveArtifact 用 vi.fn 可编程返回。
import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import { saveFileTool } from './save-file'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(async (input) => ({
      platform: input.platform,
      shell: 'test',
      command: input.command,
      cwd: input.cwd ?? '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    })),
    renderCard: vi.fn(() => ({ cardId: 'card-1' })),
    saveArtifact: vi.fn(() => ({ artifactId: 'art-1' })),
    ...overrides,
  }
}

describe('save_file tool（agentNew · 经 ctx.saveArtifact，不碰 atom）', () => {
  it('合法参数 → ctx.saveArtifact 被调，返回 {ok:true, data.accepted/artifactId/bytes}', async () => {
    const saveArtifact = vi.fn(() => ({ artifactId: 'art-42' }))
    const ctx = makeCtx({ saveArtifact })

    const result = await saveFileTool.execute(
      { filename: '  note.txt  ', content: 'hello', mimeType: 'text/plain' },
      ctx,
    )

    // filename trim；content 原样；mimeType 非空才带。
    expect(saveArtifact).toHaveBeenCalledWith({
      filename: 'note.txt',
      content: 'hello',
      mimeType: 'text/plain',
    })
    expect(result).toEqual({
      ok: true,
      data: { accepted: true, artifactId: 'art-42', bytes: 5 },
    })
  })

  it('空串 content 合法 → saveArtifact 被调，bytes:0', async () => {
    const saveArtifact = vi.fn(() => ({ artifactId: 'art-empty' }))
    const ctx = makeCtx({ saveArtifact })

    const result = await saveFileTool.execute({ filename: 'empty.txt', content: '' }, ctx)

    expect(saveArtifact).toHaveBeenCalledWith({ filename: 'empty.txt', content: '' })
    expect(result).toEqual({
      ok: true,
      data: { accepted: true, artifactId: 'art-empty', bytes: 0 },
    })
  })

  it('空 mimeType 不保留（只当非空 string 才带）', async () => {
    const saveArtifact = vi.fn(() => ({ artifactId: 'art-x' }))
    const ctx = makeCtx({ saveArtifact })

    await saveFileTool.execute({ filename: 'a.txt', content: 'x', mimeType: '   ' }, ctx)

    expect(saveArtifact).toHaveBeenCalledWith({ filename: 'a.txt', content: 'x' })
  })

  it('saveArtifact 返回 {error} → {ok:false, error}', async () => {
    const saveArtifact = vi.fn(() => ({ error: 'stale' }))
    const ctx = makeCtx({ saveArtifact })

    const result = await saveFileTool.execute({ filename: 'a.txt', content: 'x' }, ctx)

    expect(result).toEqual({ ok: false, error: 'stale' })
  })

  it('filename 空 → {ok:false}，且不调 saveArtifact', async () => {
    const saveArtifact = vi.fn(() => ({ artifactId: 'x' }))
    const ctx = makeCtx({ saveArtifact })

    const result = await saveFileTool.execute({ filename: '   ', content: 'x' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid save_file: filename (non-empty) and string content are required',
    })
    expect(saveArtifact).not.toHaveBeenCalled()
  })

  it('content 非 string → {ok:false}，且不调 saveArtifact', async () => {
    const saveArtifact = vi.fn(() => ({ artifactId: 'x' }))
    const ctx = makeCtx({ saveArtifact })

    const result = await saveFileTool.execute({ filename: 'a.txt', content: 123 }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid save_file: filename (non-empty) and string content are required',
    })
    expect(saveArtifact).not.toHaveBeenCalled()
  })

  it('是一个 browser runtime 工具，且带 skill 文档', () => {
    expect(saveFileTool.name).toBe('save_file')
    expect(saveFileTool.runtime).toBe('browser')
    expect(typeof saveFileTool.skill.description).toBe('string')
    expect(saveFileTool.skill.content.length).toBeGreaterThan(0)
  })
})
