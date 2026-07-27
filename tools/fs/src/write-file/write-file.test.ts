import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import { writeFileTool } from './write-file'

const DEFAULT_MAX_BYTES = 200 * 1024
const MAX_BYTES = 1024 * 1024

type WriteInput = {
  path: string
  content: string
  mode: 'create' | 'overwrite' | 'append'
  expectedOldContent?: string
  expectedContentHash?: string
  createDirs: boolean
  maxBytes: number
}

type WriteResult = {
  ok: boolean
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  appended: boolean
  error?: string
}

type WriteCtx = ToolContext & {
  writeWorkspaceFile(input: WriteInput): Promise<WriteResult>
}

function makeWriteResult(input: WriteInput, overrides: Partial<WriteResult> = {}): WriteResult {
  return {
    ok: true,
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).length,
    created: input.mode === 'create',
    overwritten: input.mode === 'overwrite',
    appended: input.mode === 'append',
    ...overrides,
  }
}

function makeCtx(writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))): WriteCtx {
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
    writeWorkspaceFile,
  } as WriteCtx
}

describe('write_file tool', () => {
  it('create 参数默认值 → ctx.writeWorkspaceFile 被调用，返回 {ok:true, data}', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    const result = await writeFileTool.execute({ path: '  notes/a.txt  ', content: 'hello' }, ctx)

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'notes/a.txt',
      content: 'hello',
      mode: 'create',
      createDirs: false,
      maxBytes: DEFAULT_MAX_BYTES,
    })
    expect(result).toEqual({
      ok: true,
      data: makeWriteResult({
        path: 'notes/a.txt',
        content: 'hello',
        mode: 'create',
        createDirs: false,
        maxBytes: DEFAULT_MAX_BYTES,
      }),
    })
  })

  it('overwrite 参数保留 expectedOldContent/createDirs/maxBytes', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute(
      {
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedOldContent: 'old',
        createDirs: true,
        maxBytes: 500,
      },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'new',
      mode: 'overwrite',
      expectedOldContent: 'old',
      createDirs: true,
      maxBytes: 500,
    })
  })

  it('overwrite 参数透传 read_file 返回的 expectedContentHash', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)
    const expectedContentHash = `sha256:${'a'.repeat(64)}`

    await writeFileTool.execute(
      {
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedContentHash,
      },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'new',
      mode: 'overwrite',
      expectedContentHash,
      createDirs: false,
      maxBytes: DEFAULT_MAX_BYTES,
    })
  })

  it('append 参数按文本追加模式透传', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute(
      { path: 'log.txt', content: '\nline', mode: 'append', createDirs: true },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'log.txt',
      content: '\nline',
      mode: 'append',
      createDirs: true,
      maxBytes: DEFAULT_MAX_BYTES,
    })
  })

  it('非法参数 → {ok:false} 且不调用 ctx', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await expect(writeFileTool.execute({ path: '   ', content: 'x' }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: path (non-empty) and string content are required',
    })
    await expect(writeFileTool.execute({ path: 'a.txt', content: 1 }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: path (non-empty) and string content are required',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', mode: 'bad' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: mode must be create, overwrite, or append',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', createDirs: 'yes' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: createDirs must be a boolean when provided',
    })
    await expect(writeFileTool.execute({ path: 'a.txt', content: 'a\0b' }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: binary content is not supported',
    })
    await expect(
      writeFileTool.execute({
        path: 'a.txt',
        content: 'x',
        mode: 'overwrite',
        expectedContentHash: 'sha256:not-a-hash',
      }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: expectedContentHash must use sha256:<64 lowercase hex characters>',
    })
    await expect(
      writeFileTool.execute({
        path: 'a.txt',
        content: 'x',
        expectedOldContent: 'old',
      }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: optimistic guards are only valid with mode "overwrite"',
    })
    await expect(
      writeFileTool.execute({
        path: 'a.txt',
        content: 'x',
        mode: 'overwrite',
        expectedOldContent: 'old',
        expectedContentHash: `sha256:${'a'.repeat(64)}`,
      }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: pass either expectedOldContent or expectedContentHash, not both',
    })
    expect(writeWorkspaceFile).not.toHaveBeenCalled()
  })

  it('maxBytes 执行上限 clamp，并拒绝超过 clamp 后上限的内容', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute(
      { path: 'a.txt', content: 'x', maxBytes: Number.MAX_SAFE_INTEGER },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'x',
      mode: 'create',
      createDirs: false,
      maxBytes: MAX_BYTES,
    })

    const tooLarge = 'x'.repeat(MAX_BYTES + 1)
    const result = await writeFileTool.execute(
      { path: 'big.txt', content: tooLarge, maxBytes: Number.MAX_SAFE_INTEGER },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: `invalid write_file: content is too large (${MAX_BYTES + 1} bytes > ${MAX_BYTES})`,
    })
    expect(writeWorkspaceFile).toHaveBeenCalledTimes(1)
  })

  it('ctx.writeWorkspaceFile 抛错 → {ok:false, error}', async () => {
    const writeWorkspaceFile = vi.fn(async (_input: WriteInput): Promise<WriteResult> => {
      throw new Error('boom')
    })
    const ctx = makeCtx(writeWorkspaceFile)

    const result = await writeFileTool.execute({ path: 'a.txt', content: 'x' }, ctx)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('ctx.writeWorkspaceFile 业务拒绝 → 顶层 {ok:false, error}', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) =>
      makeWriteResult(input, {
        ok: false,
        bytesWritten: 0,
        created: false,
        error: 'expectedOldContent does not match current file content',
      }),
    )
    const ctx = makeCtx(writeWorkspaceFile)

    const result = await writeFileTool.execute(
      {
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedOldContent: 'old',
      },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: 'expectedOldContent does not match current file content',
    })
  })

  it('ctx 未接 writeWorkspaceFile → {ok:false, error}', async () => {
    const ctx = makeCtx()
    delete (ctx as Partial<WriteCtx>).writeWorkspaceFile

    const result = await writeFileTool.execute({ path: 'a.txt', content: 'x' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'write_file is unavailable: ctx.writeWorkspaceFile is not configured',
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(writeFileTool.name).toBe('write_file')
    expect(writeFileTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(writeFileTool.inputSchema).toMatchObject({
      required: ['path', 'content'],
      properties: {
        expectedOldContent: {
          description: expect.stringContaining('complete, untruncated current file'),
        },
        expectedContentHash: {
          pattern: '^sha256:[0-9a-f]{64}$',
        },
      },
    })
    expect(writeFileTool.skill.content.length).toBeGreaterThan(0)
  })
})
