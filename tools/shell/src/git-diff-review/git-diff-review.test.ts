import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import { gitDiffReviewTool } from './git-diff-review'

interface WorkspaceDiffInput {
  paths?: string[]
  staged?: boolean
  base?: string
  maxDiffChars?: number
  includeStat?: boolean
}

interface WorkspaceDiffResult {
  base?: string
  statusShort: string
  stat?: string
  diff: string
  changedFiles: string[]
  truncated: boolean
  exitCode: number
  stderr: string
}

type TestToolContext = ToolContext & {
  getWorkspaceDiff(input: WorkspaceDiffInput): Promise<WorkspaceDiffResult>
}

function makeWorkspaceDiffResult(overrides: Partial<WorkspaceDiffResult> = {}): WorkspaceDiffResult {
  return {
    statusShort: ' M src/a.ts\n',
    stat: ' src/a.ts | 1 +\n',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n',
    changedFiles: ['src/a.ts'],
    truncated: false,
    exitCode: 0,
    stderr: '',
    ...overrides,
  }
}

function makeCtx(
  getWorkspaceDiff: TestToolContext['getWorkspaceDiff'] = vi.fn(async () =>
    makeWorkspaceDiffResult(),
  ),
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
    renderCard: vi.fn(() => ({ cardId: 'card-1' })),
    saveArtifact: vi.fn(() => ({ artifactId: 'art-1' })),
    getWorkspaceDiff,
  }
}

describe('git_diff_review tool', () => {
  it('默认参数 → ctx.getWorkspaceDiff 被调用，返回 {ok:true, data}', async () => {
    const workspaceResult = makeWorkspaceDiffResult()
    const getWorkspaceDiff = vi.fn(async () => workspaceResult)
    const ctx = makeCtx(getWorkspaceDiff)

    const result = await gitDiffReviewTool.execute({}, ctx)

    expect(getWorkspaceDiff).toHaveBeenCalledWith({
      paths: undefined,
      staged: false,
      base: undefined,
      maxDiffChars: 20_000,
      includeStat: true,
    })
    expect(result).toEqual({ ok: true, data: workspaceResult })
  })

  it('paths/maxDiffChars/staged/includeStat 被规范化并传给 ctx', async () => {
    const getWorkspaceDiff = vi.fn(async () => makeWorkspaceDiffResult({ diff: 'staged diff' }))
    const ctx = makeCtx(getWorkspaceDiff)

    const result = await gitDiffReviewTool.execute(
      {
        paths: ['  src/a.ts  ', './src/b.ts'],
        staged: true,
        base: 'origin/main',
        maxDiffChars: 999_999,
        includeStat: false,
      },
      ctx,
    )

    expect(getWorkspaceDiff).toHaveBeenCalledWith({
      paths: ['src/a.ts', './src/b.ts'],
      staged: true,
      base: 'origin/main',
      maxDiffChars: 100_000,
      includeStat: false,
    })
    expect(result).toMatchObject({ ok: true })
  })

  it('拒绝可能被 git 解析为选项的 base', async () => {
    const getWorkspaceDiff = vi.fn(async () => makeWorkspaceDiffResult())
    const ctx = makeCtx(getWorkspaceDiff)

    const result = await gitDiffReviewTool.execute({ base: '--output=/tmp/x' }, ctx)

    expect(result).toMatchObject({ ok: false })
    expect(getWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('非法 paths → {ok:false}，且不调 ctx.getWorkspaceDiff', async () => {
    const getWorkspaceDiff = vi.fn(async () => makeWorkspaceDiffResult())
    const ctx = makeCtx(getWorkspaceDiff)

    const result = await gitDiffReviewTool.execute({ paths: ['src/../secret.ts'] }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid git_diff_review: paths must be workspace-relative strings without parent traversal',
      code: 'GIT_DIFF_INVALID_INPUT',
      retryable: false,
    })
    expect(getWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('ctx.getWorkspaceDiff 抛错 → {ok:false, error}', async () => {
    const getWorkspaceDiff = vi.fn(async (): Promise<WorkspaceDiffResult> => {
      throw new Error('boom')
    })
    const ctx = makeCtx(getWorkspaceDiff)

    const result = await gitDiffReviewTool.execute({}, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'boom',
      code: 'GIT_DIFF_FAILED',
      retryable: false,
    })
  })

  it('ctx 未接 getWorkspaceDiff → {ok:false, error}', async () => {
    const ctx = makeCtx()
    delete (ctx as Partial<TestToolContext>).getWorkspaceDiff

    const result = await gitDiffReviewTool.execute({}, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'git_diff_review unavailable: ctx.getWorkspaceDiff is not configured',
      code: 'GIT_DIFF_UNAVAILABLE',
      retryable: false,
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(gitDiffReviewTool.name).toBe('git_diff_review')
    expect(gitDiffReviewTool.runtime).toBe('server') // 依赖 Tauri Git（TP3）。
    expect(gitDiffReviewTool.inputSchema).toMatchObject({ type: 'object' })
    expect(gitDiffReviewTool.skill.content.length).toBeGreaterThan(0)
  })
})
