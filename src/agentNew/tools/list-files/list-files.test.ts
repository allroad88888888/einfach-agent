import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../types'
import type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  WorkspaceRuntimeResult,
} from '../../runtime/workspaceRead'
import { listFilesTool } from './list-files'

type TestCtx = ToolContext & {
  listWorkspaceFiles: (input: ListWorkspaceFilesInput) => Promise<WorkspaceRuntimeResult<ListWorkspaceFilesResult>>
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
    listWorkspaceFiles: vi.fn(async () => ({
      ok: true as const,
      data: { entries: [{ path: 'src', type: 'directory' }], truncated: false },
    })),
    ...overrides,
  }
}

describe('list_files tool', () => {
  it('合法参数 → ctx.listWorkspaceFiles 被调用，返回 entries', async () => {
    const data = {
      entries: [{ path: 'src/a.ts', type: 'file', size: 12 }],
      truncated: false,
    }
    const listWorkspaceFiles = vi.fn(async () => ({ ok: true as const, data }))
    const ctx = makeCtx({ listWorkspaceFiles })

    const result = await listFilesTool.execute(
      { path: '  src  ', recursive: true, maxEntries: 50, includeHidden: true },
      ctx,
    )

    expect(listWorkspaceFiles).toHaveBeenCalledWith({
      path: 'src',
      recursive: true,
      maxEntries: 50,
      includeHidden: true,
    })
    expect(result).toEqual({ ok: true, data })
  })

  it('缺省参数 → 使用 path "."、非递归、不含隐藏、默认 maxEntries', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { entries: [], truncated: false },
    }))
    const ctx = makeCtx({ listWorkspaceFiles })

    await listFilesTool.execute({}, ctx)

    expect(listWorkspaceFiles).toHaveBeenCalledWith({
      path: '.',
      recursive: false,
      maxEntries: 200,
      includeHidden: false,
    })
  })

  it('maxEntries 执行上限 clamp，非法布尔值回默认', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { entries: [], truncated: false },
    }))
    const ctx = makeCtx({ listWorkspaceFiles })

    await listFilesTool.execute(
      { path: 'src', recursive: 'yes', includeHidden: 'yes', maxEntries: 999_999 },
      ctx,
    )

    expect(listWorkspaceFiles).toHaveBeenCalledWith({
      path: 'src',
      recursive: false,
      maxEntries: 2_000,
      includeHidden: false,
    })
  })

  it('ctx 返回结构化错误 → {ok:false, error}', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({ ok: false as const, error: 'outside root' }))
    const ctx = makeCtx({ listWorkspaceFiles })

    const result = await listFilesTool.execute({ path: '../x' }, ctx)

    expect(result).toEqual({ ok: false, error: 'outside root' })
  })

  it('ctx 抛错 → {ok:false, error}', async () => {
    const listWorkspaceFiles = vi.fn(async (): Promise<WorkspaceRuntimeResult<ListWorkspaceFilesResult>> => {
      throw new Error('boom')
    })
    const ctx = makeCtx({ listWorkspaceFiles })

    const result = await listFilesTool.execute({ path: '.' }, ctx)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(listFilesTool.name).toBe('list_files')
    expect(listFilesTool.runtime).toBe('server') // 依赖 Tauri 文件系统（TP3）。
    expect(listFilesTool.inputSchema).toMatchObject({ properties: { maxEntries: { maximum: 2_000 } } })
    expect(listFilesTool.skill.content.length).toBeGreaterThan(0)
  })
})
