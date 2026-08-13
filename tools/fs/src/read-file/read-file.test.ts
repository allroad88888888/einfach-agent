import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import type {
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import { readFileTool } from './read-file'

type TestCtx = ToolContext & {
  readWorkspaceFile: (input: ReadWorkspaceFileInput) => Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>
}

function makeCtx(overrides: Partial<TestCtx> = {}): TestCtx {
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
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    readWorkspaceFile: vi.fn(async () => ({
      ok: true as const,
      data: { path: 'README.md', content: 'hello', truncated: false, bytes: 5 },
    })),
    ...overrides,
  }
}

describe('read_file tool', () => {
  it('合法参数 → ctx.readWorkspaceFile 被调用，返回文件内容', async () => {
    const data = {
      path: 'src/a.ts',
      content: 'const a = 1',
      truncated: false,
      bytes: 11,
      contentHash: `sha256:${'a'.repeat(64)}`,
    }
    const readWorkspaceFile = vi.fn(async () => ({ ok: true as const, data }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: '  src/a.ts  ', maxBytes: 1234 }, ctx)

    expect(readWorkspaceFile).toHaveBeenCalledWith({ path: 'src/a.ts', maxBytes: 1234, offset: 0 })
    expect(result).toEqual({ ok: true, data })
  })

  it('非法 path → {ok:false}，且不调 ctx', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'x', content: '', truncated: false, bytes: 0 },
    }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: '   ' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid read_file: path (non-empty string) is required',
      code: 'WORKSPACE_READ_INVALID_INPUT',
      retryable: false,
    })
    expect(readWorkspaceFile).not.toHaveBeenCalled()
  })

  it('maxBytes 使用默认值并执行上限 clamp', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'a.txt', content: '', truncated: false, bytes: 0 },
    }))
    const ctx = makeCtx({ readWorkspaceFile })

    await readFileTool.execute({ path: 'a.txt' }, ctx)
    await readFileTool.execute({ path: 'a.txt', maxBytes: 999_999 }, ctx)

    expect(readWorkspaceFile).toHaveBeenNthCalledWith(1, {
      path: 'a.txt',
      maxBytes: 20_000,
      offset: 0,
    })
    expect(readWorkspaceFile).toHaveBeenNthCalledWith(2, {
      path: 'a.txt',
      maxBytes: 200_000,
      offset: 0,
    })
  })

  it('forwards the exact next byte offset for chunked reads', async () => {
    const data = {
      path: 'large.txt',
      content: 'next',
      truncated: true,
      bytes: 4,
      offset: 20_000,
      totalBytes: 40_000,
      nextOffset: 20_004,
    }
    const readWorkspaceFile = vi.fn(async () => ({ ok: true as const, data }))

    const result = await readFileTool.execute(
      { path: 'large.txt', maxBytes: 4, offset: 20_000 },
      makeCtx({ readWorkspaceFile }),
    )

    expect(readWorkspaceFile).toHaveBeenCalledWith({
      path: 'large.txt',
      maxBytes: 4,
      offset: 20_000,
    })
    expect(result).toEqual({ ok: true, data })
  })

  it('rejects unsafe or negative offsets', async () => {
    const ctx = makeCtx()

    expect(await readFileTool.execute({ path: 'a.txt', offset: -1 }, ctx)).toEqual({
      ok: false,
      error: 'invalid read_file: offset must be a non-negative safe integer',
      code: 'WORKSPACE_READ_INVALID_INPUT',
      retryable: false,
    })
    expect(await readFileTool.execute({ path: 'a.txt', offset: Number.MAX_VALUE }, ctx)).toEqual({
      ok: false,
      error: 'invalid read_file: offset must be a non-negative safe integer',
      code: 'WORKSPACE_READ_INVALID_INPUT',
      retryable: false,
    })
  })

  it('ctx 返回结构化错误 → {ok:false, error}', async () => {
    const readWorkspaceFile = vi.fn(async () => ({ ok: false as const, error: 'outside root' }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: '../secret' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'outside root',
      code: 'WORKSPACE_READ_FAILED',
      retryable: false,
    })
  })

  it('ctx 抛错 → {ok:false, error}', async () => {
    const readWorkspaceFile = vi.fn(async (): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => {
      throw new Error('boom')
    })
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: 'a.txt' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'boom',
      code: 'WORKSPACE_READ_FAILED',
      retryable: false,
    })
  })

  it('startLine/lineCount 透传，供 rg_search 的行号直接接续', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      data: {
        path: 'src/a.ts',
        content: 'three\nfour\n',
        truncated: true,
        bytes: 11,
        startLine: 3,
        endLine: 4,
        nextLine: 5,
        totalLines: 9,
      },
    }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute(
      { path: 'src/a.ts', startLine: 3, lineCount: 2 },
      ctx,
    )

    expect(readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/a.ts', startLine: 3, lineCount: 2 }),
    )
    expect(result).toMatchObject({
      ok: true,
      data: expect.objectContaining({ startLine: 3, endLine: 4, nextLine: 5, totalLines: 9 }),
    })
  })

  it('不传行参数时不污染请求', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'a.txt', content: 'x', truncated: false, bytes: 1 },
    }))
    const ctx = makeCtx({ readWorkspaceFile })

    await readFileTool.execute({ path: 'a.txt' }, ctx)

    expect(readWorkspaceFile).toHaveBeenCalledWith({ path: 'a.txt', maxBytes: 20_000, offset: 0 })
  })

  it('offset 与 startLine 互斥；行号必须是 >= 1 的整数', async () => {
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      data: { path: 'a.txt', content: '', truncated: false, bytes: 0 },
    }))
    const ctx = makeCtx({ readWorkspaceFile })

    await expect(
      readFileTool.execute({ path: 'a.txt', offset: 10, startLine: 2 }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('not both'),
      code: 'WORKSPACE_READ_INVALID_INPUT',
    })
    await expect(
      readFileTool.execute({ path: 'a.txt', startLine: 0 }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      error: 'invalid read_file: startLine must be an integer >= 1',
    })
    await expect(
      readFileTool.execute({ path: 'a.txt', lineCount: 0 }, ctx),
    ).resolves.toMatchObject({
      ok: false,
      error: 'invalid read_file: lineCount must be an integer >= 1',
    })

    // offset 为 0（默认）时不算冲突，仍可用行定位。
    await expect(
      readFileTool.execute({ path: 'a.txt', offset: 0, startLine: 2 }, ctx),
    ).resolves.toMatchObject({ ok: true })
    expect(readWorkspaceFile).toHaveBeenCalledTimes(1)
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(readFileTool.name).toBe('read_file')
    expect(readFileTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(readFileTool.inputSchema).toMatchObject({
      required: ['path'],
      properties: {
        startLine: { minimum: 1 },
        lineCount: { minimum: 1 },
      },
    })
    expect(readFileTool.skill.content.length).toBeGreaterThan(0)
  })
})
