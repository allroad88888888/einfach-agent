import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import { writeFileTool } from './write-file'

const MAX_BYTES = 8 * 1024 * 1024

type WriteInput = {
  path: string
  content: string
  mode: 'create' | 'overwrite' | 'append' | 'upsert'
  encoding?: 'utf8' | 'base64'
  executable?: boolean
  dryRun?: boolean
  expectedOldContent?: string
  expectedContentHash?: string
  createDirs: boolean
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
  it('create 参数默认值：createDirs 默认 true，不再透传 maxBytes', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    const result = await writeFileTool.execute({ path: '  notes/a.txt  ', content: 'hello' }, ctx)

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'notes/a.txt',
      content: 'hello',
      mode: 'create',
      createDirs: true,
    })
    expect(result).toEqual({
      ok: true,
      data: makeWriteResult({
        path: 'notes/a.txt',
        content: 'hello',
        mode: 'create',
        createDirs: true,
      }),
    })
  })

  it('createDirs 可显式关闭', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute({ path: 'a.txt', content: 'x', createDirs: false }, ctx)

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ createDirs: false }),
    )
  })

  it('overwrite 参数保留 expectedOldContent/createDirs', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute(
      {
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedOldContent: 'old',
        createDirs: true,
      },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'new',
      mode: 'overwrite',
      expectedOldContent: 'old',
      createDirs: true,
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
      createDirs: true,
    })
  })

  it('upsert 模式透传，且允许携带乐观锁', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)
    const expectedContentHash = `sha256:${'b'.repeat(64)}`

    await writeFileTool.execute(
      { path: 'a.txt', content: 'new', mode: 'upsert', expectedContentHash },
      ctx,
    )

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'new',
      mode: 'upsert',
      expectedContentHash,
      createDirs: true,
    })
  })

  it('base64 编码透传，且 NUL 字节在此模式下不再被拦', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    const result = await writeFileTool.execute(
      { path: 'img.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
      ctx,
    )

    expect(result).toMatchObject({ ok: true })
    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'img.png',
      content: 'iVBORw0KGgo=',
      mode: 'create',
      encoding: 'base64',
      createDirs: true,
    })
  })

  it('encoding=utf8 是默认值，不占用透传字段', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute({ path: 'a.txt', content: 'x', encoding: 'utf8' }, ctx)

    expect(writeWorkspaceFile).toHaveBeenCalledWith({
      path: 'a.txt',
      content: 'x',
      mode: 'create',
      createDirs: true,
    })
  })

  it('executable 与 dryRun 透传，false 也必须透传', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)

    await writeFileTool.execute(
      { path: 'run.sh', content: '#!/bin/sh\n', mode: 'upsert', executable: true, dryRun: true },
      ctx,
    )
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ executable: true, dryRun: true }),
    )

    // executable:false 是「清掉执行位」的显式意图，不能被当成未提供而丢掉。
    await writeFileTool.execute(
      { path: 'run.sh', content: '#!/bin/sh\n', mode: 'overwrite', executable: false },
      ctx,
    )
    expect(writeWorkspaceFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ executable: false }),
    )
  })

  it('append 也允许乐观锁，用于可重试的分块追加', async () => {
    const writeWorkspaceFile = vi.fn(async (input: WriteInput) => makeWriteResult(input))
    const ctx = makeCtx(writeWorkspaceFile)
    const expectedContentHash = `sha256:${'c'.repeat(64)}`

    const result = await writeFileTool.execute(
      { path: 'log.jsonl', content: '{}\n', mode: 'append', expectedContentHash },
      ctx,
    )

    expect(result).toMatchObject({ ok: true })
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'append', expectedContentHash }),
    )
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
      error: 'invalid write_file: mode must be create, overwrite, upsert, or append',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', createDirs: 'yes' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: createDirs must be a boolean when provided',
    })
    await expect(writeFileTool.execute({ path: 'a.txt', content: 'a\0b' }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: binary content requires encoding "base64"',
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
      error:
        'invalid write_file: optimistic guards are not valid with mode "create"; the file must not exist',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', encoding: 'hex' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: encoding must be utf8 or base64',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', executable: 'yes' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: executable must be a boolean when provided',
    })
    await expect(
      writeFileTool.execute({ path: 'a.txt', content: 'x', dryRun: 'yes' }, ctx),
    ).resolves.toEqual({
      ok: false,
      error: 'invalid write_file: dryRun must be a boolean when provided',
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

  it('内容上限固定为 1 MB，模型传入的 maxBytes 不再参与也不再透传', async () => {
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
      createDirs: true,
    })

    // 曾经可以靠调大 maxBytes 抬高上限；现在上限是固定的，调不动。
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
        mode: { enum: ['create', 'overwrite', 'append', 'upsert'] },
        encoding: { enum: ['utf8', 'base64'] },
        createDirs: { default: true },
        expectedOldContent: {
          description: expect.stringContaining('complete, untruncated current file'),
        },
        expectedContentHash: {
          pattern: '^sha256:[0-9a-f]{64}$',
        },
      },
    })
    // maxBytes 曾经是纯噪声参数：模型只会为过校验把它调大，真正的上限在 host 侧。
    expect(writeFileTool.inputSchema.properties).not.toHaveProperty('maxBytes')
    expect(writeFileTool.skill.content.length).toBeGreaterThan(0)
  })
})
