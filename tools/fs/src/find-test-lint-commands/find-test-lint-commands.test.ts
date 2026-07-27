import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
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
        warnings: ['Python command not declared'],
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
