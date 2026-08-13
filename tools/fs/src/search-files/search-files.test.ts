import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import type {
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import type { RgSearchInput, RgSearchResult } from '@web-agent/core/runtime/workspaceRg'
import { searchFilesTool } from './search-files'

type TestCtx = ToolContext & {
  searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) => Promise<WorkspaceRuntimeResult<SearchWorkspaceFilesResult>>
  rgSearchWorkspace?: (input: RgSearchInput) => Promise<RgSearchResult>
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
    searchWorkspaceFiles: vi.fn(async () => ({
      ok: true as const,
      data: { matches: [{ path: 'src/a.ts', line: 'const query = 1', lineNumber: 3 }], truncated: false },
    })),
    ...overrides,
  }
}

describe('search_files tool', () => {
  it('合法参数 → ctx.searchWorkspaceFiles 被调用，返回 matches', async () => {
    const data = {
      matches: [{ path: 'src/a.ts', line: 'const needle = true', lineNumber: 7 }],
      truncated: false,
    }
    const searchWorkspaceFiles = vi.fn(async () => ({ ok: true as const, data }))
    const ctx = makeCtx({ searchWorkspaceFiles })

    const result = await searchFilesTool.execute(
      { query: '  needle  ', path: ' src ', glob: ' *.ts ', maxMatches: 5 },
      ctx,
    )

    expect(searchWorkspaceFiles).toHaveBeenCalledWith({
      query: 'needle',
      path: 'src',
      glob: '*.ts',
      maxMatches: 5,
    })
    expect(result).toEqual({ ok: true, data })
  })

  it('优先使用 ripgrep，并把结果归一化为 search_files 形状', async () => {
    const rgSearchWorkspace = vi.fn(async (): Promise<RgSearchResult> => ({
      ok: true,
      matches: [{
        path: 'src/a.ts',
        lineNumber: 7,
        column: 9,
        line: 'const needle = true',
        before: [],
        after: [],
      }],
      truncated: false,
      exitCode: 0,
      stderr: '',
    }))
    const searchWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { matches: [], truncated: false },
    }))

    const result = await searchFilesTool.execute(
      { query: 'needle', path: 'src', glob: '*.ts', maxMatches: 5 },
      makeCtx({ rgSearchWorkspace, searchWorkspaceFiles }),
    )

    expect(rgSearchWorkspace).toHaveBeenCalledWith({
      query: 'needle',
      path: 'src',
      regex: false,
      caseSensitive: true,
      globs: ['*.ts'],
      contextLines: 0,
      maxMatches: 5,
    })
    expect(searchWorkspaceFiles).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [{ path: 'src/a.ts', line: 'const needle = true', lineNumber: 7 }],
        truncated: false,
      },
    })
  })

  it('ripgrep 不可用时退回内置搜索', async () => {
    const rgSearchWorkspace = vi.fn(async (): Promise<RgSearchResult> => ({
      ok: false,
      matches: [],
      truncated: false,
      exitCode: 1,
      stderr: 'failed to spawn `rg`',
    }))
    const data = {
      matches: [{ path: 'README.md', line: 'needle', lineNumber: 2 }],
      truncated: false,
    }
    const searchWorkspaceFiles = vi.fn(async () => ({ ok: true as const, data }))

    const result = await searchFilesTool.execute(
      { query: 'needle' },
      makeCtx({ rgSearchWorkspace, searchWorkspaceFiles }),
    )

    expect(searchWorkspaceFiles).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, data })
  })

  it('ripgrep bridge 抛错时也退回内置搜索', async () => {
    const rgSearchWorkspace = vi.fn(async (): Promise<RgSearchResult> => {
      throw new Error('rg command not found')
    })
    const data = {
      matches: [{ path: 'README.md', line: 'needle', lineNumber: 2 }],
      truncated: false,
    }
    const searchWorkspaceFiles = vi.fn(async () => ({ ok: true as const, data }))

    const result = await searchFilesTool.execute(
      { query: 'needle' },
      makeCtx({ rgSearchWorkspace, searchWorkspaceFiles }),
    )

    expect(searchWorkspaceFiles).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, data })
  })

  it('非法 query → {ok:false}，且不调 ctx', async () => {
    const searchWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { matches: [], truncated: false },
    }))
    const ctx = makeCtx({ searchWorkspaceFiles })

    const result = await searchFilesTool.execute({ query: '   ' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid search_files: query (non-empty string) is required',
      code: 'SEARCH_FILES_INVALID_INPUT',
      retryable: false,
    })
    expect(searchWorkspaceFiles).not.toHaveBeenCalled()
  })

  it('可选参数使用默认值，maxMatches 执行上限 clamp', async () => {
    const searchWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { matches: [], truncated: false },
    }))
    const ctx = makeCtx({ searchWorkspaceFiles })

    await searchFilesTool.execute({ query: 'q' }, ctx)
    await searchFilesTool.execute({ query: 'q', maxMatches: 999_999, glob: '   ' }, ctx)

    expect(searchWorkspaceFiles).toHaveBeenNthCalledWith(1, {
      query: 'q',
      path: '.',
      glob: undefined,
      maxMatches: 100,
    })
    expect(searchWorkspaceFiles).toHaveBeenNthCalledWith(2, {
      query: 'q',
      path: '.',
      glob: undefined,
      maxMatches: 1_000,
    })
  })

  it('ctx 返回结构化错误 → {ok:false, error}', async () => {
    const searchWorkspaceFiles = vi.fn(async () => ({ ok: false as const, error: 'outside root' }))
    const ctx = makeCtx({ searchWorkspaceFiles })

    const result = await searchFilesTool.execute({ query: 'q', path: '../x' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'outside root',
      code: 'SEARCH_FILES_FAILED',
      retryable: false,
    })
  })

  it('ctx 抛错 → {ok:false, error}', async () => {
    const searchWorkspaceFiles = vi.fn(async (): Promise<WorkspaceRuntimeResult<SearchWorkspaceFilesResult>> => {
      throw new Error('boom')
    })
    const ctx = makeCtx({ searchWorkspaceFiles })

    const result = await searchFilesTool.execute({ query: 'q' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      error: 'boom',
      code: 'SEARCH_FILES_FAILED',
      retryable: false,
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(searchFilesTool.name).toBe('search_files')
    expect(searchFilesTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(searchFilesTool.inputSchema).toMatchObject({ required: ['query'] })
    expect(searchFilesTool.skill.content.length).toBeGreaterThan(0)
  })
})
