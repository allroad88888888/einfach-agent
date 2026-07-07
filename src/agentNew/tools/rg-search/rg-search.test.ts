import { describe, it, expect, vi } from 'vitest'
import type { RgSearchInput, RgSearchResult } from '../../runtime/workspaceRg'
import type { ToolContext } from '../types'
import { rgSearchTool } from './rg-search'

type TestToolContext = ToolContext & {
  rgSearchWorkspace(input: RgSearchInput): Promise<RgSearchResult>
}

function makeResult(overrides: Partial<RgSearchResult> = {}): RgSearchResult {
  return {
    ok: true,
    matches: [],
    truncated: false,
    exitCode: 1,
    stderr: '',
    ...overrides,
  }
}

function makeCtx(
  rgSearchWorkspace: TestToolContext['rgSearchWorkspace'] = vi.fn(async () => makeResult()),
): TestToolContext {
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
    rgSearchWorkspace,
  }
}

describe('rg_search tool', () => {
  it('默认参数 → ctx.rgSearchWorkspace 被调用，返回 {ok:true,data}', async () => {
    const workspaceResult = makeResult({
      matches: [{ path: 'src/a.ts', lineNumber: 2, column: 7, line: 'hello', before: [], after: [] }],
    })
    const rgSearchWorkspace = vi.fn(async () => workspaceResult)
    const ctx = makeCtx(rgSearchWorkspace)

    const result = await rgSearchTool.execute({ query: '  hello  ' }, ctx)

    expect(rgSearchWorkspace).toHaveBeenCalledWith({
      query: 'hello',
      path: undefined,
      regex: false,
      caseSensitive: true,
      globs: undefined,
      contextLines: 0,
      maxMatches: 200,
    })
    expect(result).toEqual({ ok: true, data: workspaceResult })
  })

  it('高级参数 → 规范化后透传', async () => {
    const rgSearchWorkspace = vi.fn(async () => makeResult())
    const ctx = makeCtx(rgSearchWorkspace)

    await rgSearchTool.execute(
      {
        query: 'use[A-Z]+',
        path: ' src ',
        regex: true,
        caseSensitive: false,
        globs: [' *.ts ', '', '!dist/**'],
        contextLines: 99,
        maxMatches: 9999,
      },
      ctx,
    )

    expect(rgSearchWorkspace).toHaveBeenCalledWith({
      query: 'use[A-Z]+',
      path: 'src',
      regex: true,
      caseSensitive: false,
      globs: ['*.ts', '!dist/**'],
      contextLines: 5,
      maxMatches: 1000,
    })
  })

  it('非法 query/globs/maxMatches → {ok:false}，且不调 ctx', async () => {
    const rgSearchWorkspace = vi.fn(async () => makeResult())
    const ctx = makeCtx(rgSearchWorkspace)

    await expect(rgSearchTool.execute({ query: '   ' }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid rg_search: query (non-empty string) is required',
    })
    await expect(rgSearchTool.execute({ query: 'x', globs: [1] }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid rg_search: globs must be an array of strings',
    })
    await expect(rgSearchTool.execute({ query: 'x', maxMatches: 0 }, ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid rg_search: maxMatches must be a positive number',
    })
    expect(rgSearchWorkspace).not.toHaveBeenCalled()
  })

  it('ctx.rgSearchWorkspace 抛错 → {ok:false,error}', async () => {
    const rgSearchWorkspace = vi.fn(async (): Promise<RgSearchResult> => {
      throw new Error('boom')
    })
    const ctx = makeCtx(rgSearchWorkspace)

    const result = await rgSearchTool.execute({ query: 'hello' }, ctx)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('ctx 未接 rgSearchWorkspace → {ok:false,error}', async () => {
    const ctx = makeCtx()
    delete (ctx as Partial<TestToolContext>).rgSearchWorkspace

    const result = await rgSearchTool.execute({ query: 'hello' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'rg_search unavailable: ctx.rgSearchWorkspace is not configured',
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(rgSearchTool.name).toBe('rg_search')
    expect(rgSearchTool.runtime).toBe('server')
    expect(rgSearchTool.inputSchema).toMatchObject({ required: ['query'] })
    expect(rgSearchTool.skill.content.length).toBeGreaterThan(0)
  })
})
