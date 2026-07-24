import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
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
    const data = { path: 'src/a.ts', content: 'const a = 1', truncated: false, bytes: 11 }
    const readWorkspaceFile = vi.fn(async () => ({ ok: true as const, data }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: '  src/a.ts  ', maxBytes: 1234 }, ctx)

    expect(readWorkspaceFile).toHaveBeenCalledWith({ path: 'src/a.ts', maxBytes: 1234 })
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

    expect(readWorkspaceFile).toHaveBeenNthCalledWith(1, { path: 'a.txt', maxBytes: 20_000 })
    expect(readWorkspaceFile).toHaveBeenNthCalledWith(2, { path: 'a.txt', maxBytes: 200_000 })
  })

  it('ctx 返回结构化错误 → {ok:false, error}', async () => {
    const readWorkspaceFile = vi.fn(async () => ({ ok: false as const, error: 'outside root' }))
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: '../secret' }, ctx)

    expect(result).toEqual({ ok: false, error: 'outside root' })
  })

  it('ctx 抛错 → {ok:false, error}', async () => {
    const readWorkspaceFile = vi.fn(async (): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => {
      throw new Error('boom')
    })
    const ctx = makeCtx({ readWorkspaceFile })

    const result = await readFileTool.execute({ path: 'a.txt' }, ctx)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(readFileTool.name).toBe('read_file')
    expect(readFileTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(readFileTool.inputSchema).toMatchObject({ required: ['path'] })
    expect(readFileTool.skill.content.length).toBeGreaterThan(0)
  })
})
