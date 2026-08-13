import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import { findTestLintCommandsTool } from './find-test-lint-commands'

type TestCtx = ToolContext & {
  listWorkspaceFiles: (input: ListWorkspaceFilesInput) => Promise<WorkspaceRuntimeResult<ListWorkspaceFilesResult>>
  readWorkspaceFile: (input: ReadWorkspaceFileInput) => Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>
}

function makeCtx(overrides: Partial<TestCtx> = {}): TestCtx {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    listWorkspaceFiles: vi.fn(async () => ({
      ok: true as const,
      data: { entries: [], truncated: false },
    })),
    readWorkspaceFile: vi.fn(async ({ path }) => ({
      ok: true as const,
      data: { path, content: '', truncated: false, bytes: 0 },
    })),
    runLowCostExtraction: vi.fn(async () => ({ content: '{"commands":[],"warnings":[]}', model: 'deepseek-chat' })),
    ...overrides,
  }
}

describe('find_test_lint_commands tool', () => {
  it('reads only recognized manifests and sends their excerpts to the isolated low-cost extractor', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: {
        entries: [
          { path: 'package.json', type: 'file' },
          { path: 'services/api/pyproject.toml', type: 'file' },
          { path: 'node_modules/ignored/package.json', type: 'file' },
          { path: 'src/index.ts', type: 'file' },
        ],
        truncated: false,
      },
    }))
    const readWorkspaceFile = vi.fn(async ({ path }: ReadWorkspaceFileInput) => ({
      ok: true as const,
      data: {
        path,
        content: path === 'package.json'
          ? '{"scripts":{"test":"vitest run","lint":"eslint ."}}'
          : '[project]\nname = "api"',
        truncated: false,
        bytes: 32,
      },
    }))
    let extractionInput: Parameters<NonNullable<ToolContext['runLowCostExtraction']>>[0] | undefined
    const runLowCostExtraction = vi.fn(async (input: Parameters<NonNullable<ToolContext['runLowCostExtraction']>>[0]) => {
      extractionInput = input
      return {
        content: JSON.stringify({
          commands: [
            { kind: 'test', argv: ['pnpm', 'test'], cwd: '.', origin: 'declared', evidence: 'package.json scripts.test', confidence: 'high' },
            { kind: 'lint', argv: ['pnpm', 'lint', '&&', 'rm'], cwd: '.', origin: 'declared', evidence: 'unsafe', confidence: 'high' },
          ],
          warnings: ['Python command not declared'],
        }),
        model: 'deepseek-chat',
      }
    })
    const ctx = makeCtx({ listWorkspaceFiles, readWorkspaceFile, runLowCostExtraction })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    expect(listWorkspaceFiles).toHaveBeenCalledWith({
      path: '.', recursive: true, maxEntries: 2_000, includeHidden: false,
    })
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2)
    expect(readWorkspaceFile).toHaveBeenNthCalledWith(1, { path: 'package.json', maxBytes: 8_000, offset: 0 })
    expect(readWorkspaceFile).toHaveBeenNthCalledWith(2, { path: 'services/api/pyproject.toml', maxBytes: 8_000, offset: 0 })
    expect(runLowCostExtraction).toHaveBeenCalledOnce()
    if (!extractionInput) throw new Error('missing extraction input')
    expect(extractionInput.systemPrompt).toContain('there is no conversation or source-code context')
    expect(extractionInput.userPrompt).toContain('package.json')
    expect(extractionInput.userPrompt).not.toContain('src/index.ts')
    expect(ctx.runShell).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      data: {
        model: 'deepseek-chat',
        manifests: [
          { path: 'package.json', cwd: '.', truncated: false },
          { path: 'services/api/pyproject.toml', cwd: 'services/api', truncated: false },
        ],
        commands: [{
          kind: 'test', argv: ['pnpm', 'test'], cwd: '.', origin: 'declared', evidence: 'package.json scripts.test', confidence: 'high',
        }],
        warnings: [
          '1 extracted command(s) were discarded as malformed or outside the inspected manifest directories',
          'Python command not declared',
        ],
      },
    })
  })

  // 丢弃必须显形：不然「模型回的 cwd 全不匹配」和「本仓库确实没有命令」都长成 commands: []。
  it('reports discarded commands instead of silently returning an empty list', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { entries: [{ path: 'package.json', type: 'file' }], truncated: false },
    }))
    const runLowCostExtraction = vi.fn(async () => ({
      // cwd 带尾斜杠 → 不在白名单；单个 `&` 是后台符 → argv 清洗拒收。
      content: JSON.stringify({
        commands: [
          { kind: 'test', argv: ['pnpm', 'test'], cwd: './', origin: 'declared', evidence: 'scripts.test', confidence: 'high' },
          { kind: 'lint', argv: ['pnpm', 'lint', '&'], cwd: '.', origin: 'declared', evidence: 'scripts.lint', confidence: 'high' },
        ],
        warnings: [],
      }),
      model: 'deepseek-chat',
    }))
    const ctx = makeCtx({ listWorkspaceFiles, runLowCostExtraction })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    expect(result).toMatchObject({
      ok: true,
      data: {
        commands: [],
        warnings: ['2 extracted command(s) were discarded as malformed or outside the inspected manifest directories'],
      },
    })
  })

  // 纯字典序会把根 manifest 排在每个 apps/** 之后，MAX_MANIFESTS 截断时先丢的正是最该留的。
  it('inspects shallow manifests first so the root manifest survives the cap', async () => {
    const nested = Array.from({ length: 20 }, (_, index) => ({
      path: `apps/app-${String(index).padStart(2, '0')}/package.json`,
      type: 'file',
    }))
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { entries: [...nested, { path: 'package.json', type: 'file' }], truncated: false },
    }))
    const readWorkspaceFile = vi.fn(async ({ path }: ReadWorkspaceFileInput) => ({
      ok: true as const,
      data: { path, content: '{}', truncated: false, bytes: 2 },
    }))
    const ctx = makeCtx({ listWorkspaceFiles, readWorkspaceFile })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    const inspected = readWorkspaceFile.mock.calls.map(([input]) => input.path)
    expect(inspected).toHaveLength(16)
    expect(inspected[0]).toBe('package.json')
    expect(result).toMatchObject({
      ok: true,
      data: { warnings: ['5 deeper manifest(s) beyond the 16-manifest cap were not inspected'] },
    })
  })

  // 单文件 8KB × 16 = 128KB 会作为一条 user 消息发出，而 compactContext 对 [system,user]
  // 是硬保护、压不动。真正的护栏是聚合上限。
  it('caps the total excerpt payload and reports what it skipped', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      path: `pkg-${index}/package.json`,
      type: 'file',
    }))
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: { entries, truncated: false },
    }))
    const readWorkspaceFile = vi.fn(async ({ path, maxBytes = 0 }: ReadWorkspaceFileInput) => {
      const bytes = Math.min(7_000, maxBytes)
      return {
        ok: true as const,
        data: { path, content: 'x'.repeat(bytes), truncated: bytes < 7_000, bytes },
      }
    })
    const ctx = makeCtx({ listWorkspaceFiles, readWorkspaceFile })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    // 前 6 个各吃 7000（共 42000），第 7 个的单文件上限被收敛到剩余的 6000
    // ——而不是照发 8000 把总量顶到 54000。剩下 3 个直接跳过。
    expect(readWorkspaceFile.mock.calls.map(([input]) => input.maxBytes)).toEqual([
      8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 6_000,
    ])
    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: expect.arrayContaining([
          'pkg-6/package.json was truncated at 6000 bytes',
          '3 manifest(s) were skipped after the 48000-byte excerpt budget was exhausted',
        ]),
      },
    })
  })

  it('returns a clear unavailable result without attempting a shell fallback', async () => {
    const ctx = makeCtx({ runLowCostExtraction: undefined })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    expect(result).toMatchObject({ ok: false, code: 'COMMAND_DISCOVERY_MODEL_UNAVAILABLE', retryable: false })
    expect(ctx.listWorkspaceFiles).not.toHaveBeenCalled()
    expect(ctx.runShell).not.toHaveBeenCalled()
  })

  it('recognizes common build manifests across language ecosystems', async () => {
    const listWorkspaceFiles = vi.fn(async () => ({
      ok: true as const,
      data: {
        entries: [
          { path: 'native/CMakeLists.txt', type: 'file' },
          { path: 'services/Api.csproj', type: 'file' },
          { path: 'cli/Package.swift', type: 'file' },
          { path: 'worker/mix.exs', type: 'file' },
          { path: 'lib/project.cabal', type: 'file' },
          { path: 'src/ordinary.ts', type: 'file' },
        ],
        truncated: false,
      },
    }))
    const readWorkspaceFile = vi.fn(async ({ path }: ReadWorkspaceFileInput) => ({
      ok: true as const,
      data: { path, content: '# manifest', truncated: false, bytes: 10 },
    }))
    const ctx = makeCtx({ listWorkspaceFiles, readWorkspaceFile })

    const result = await findTestLintCommandsTool.execute({}, ctx)

    expect(readWorkspaceFile.mock.calls.map(([input]) => input.path)).toEqual([
      'cli/Package.swift', 'lib/project.cabal', 'native/CMakeLists.txt', 'services/Api.csproj', 'worker/mix.exs',
    ])
    expect(result).toMatchObject({ ok: true, data: { manifests: [
      { path: 'cli/Package.swift', cwd: 'cli' },
      { path: 'lib/project.cabal', cwd: 'lib' },
      { path: 'native/CMakeLists.txt', cwd: 'native' },
      { path: 'services/Api.csproj', cwd: 'services' },
      { path: 'worker/mix.exs', cwd: 'worker' },
    ] } })
  })
})
