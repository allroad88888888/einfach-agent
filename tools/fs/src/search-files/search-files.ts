import type { Tool, ToolContext, ToolResult } from '@web-agent/core/tools/types'
import type {
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import type { RgSearchInput, RgSearchResult } from '@web-agent/core/runtime/workspaceRg'
import guide from './search-files.md?raw'

const DEFAULT_MAX_MATCHES = 100
const MAX_MATCHES = 1_000

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    path: { type: 'string', default: '.' },
    glob: { type: 'string' },
    maxMatches: { type: 'integer', minimum: 1, maximum: MAX_MATCHES, default: DEFAULT_MAX_MATCHES },
  },
  required: ['query'],
  additionalProperties: false,
}

type MaybeWorkspaceResult<T> = WorkspaceRuntimeResult<T> | T

type WorkspaceSearchContext = ToolContext & {
  searchWorkspaceFiles(input: SearchWorkspaceFilesInput): Promise<MaybeWorkspaceResult<SearchWorkspaceFilesResult>>
  rgSearchWorkspace?(input: RgSearchInput): Promise<RgSearchResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(Math.floor(value), max)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'searchWorkspaceFiles failed'
}

function toToolResult<T>(result: MaybeWorkspaceResult<T>): ToolResult {
  if (isStructuredResult(result)) {
    return result.ok
      ? { ok: true, data: result.data }
      : {
          ok: false,
          error: result.error,
          code: 'SEARCH_FILES_FAILED',
          retryable: false,
        }
  }
  return { ok: true, data: result }
}

function isStructuredResult<T>(value: MaybeWorkspaceResult<T>): value is WorkspaceRuntimeResult<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  execution: { mode: 'parallel', effectKeys: ['workspace:read'] },
  runtime: 'server', // 依赖 Tauri 文件系统（ctx.searchWorkspaceFiles），web 下不进 manifest（TP3）。
  skill: {
    description: '按普通字符串搜索文本文件；Auto 模式也可搜索 workspace 外路径。',
    triggers: ['search files', '搜索文件', '查找文本', 'grep'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) {
      return {
        ok: false,
        error: 'invalid search_files: query (non-empty string) is required',
        code: 'SEARCH_FILES_INVALID_INPUT',
        retryable: false,
      }
    }

    const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
    const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : undefined
    const maxMatches = normalizePositiveInteger(input.maxMatches, DEFAULT_MAX_MATCHES, MAX_MATCHES)
    const searchWorkspaceFiles = (ctx as Partial<WorkspaceSearchContext>).searchWorkspaceFiles
    const rgSearchWorkspace = (ctx as Partial<WorkspaceSearchContext>).rgSearchWorkspace
    if (
      typeof rgSearchWorkspace !== 'function'
      && typeof searchWorkspaceFiles !== 'function'
    ) {
      return {
        ok: false,
        error: 'search_files is unavailable: no workspace search backend is configured',
        code: 'SEARCH_FILES_UNAVAILABLE',
        retryable: false,
      }
    }

    let rgFailure: RgSearchResult | undefined
    let rgError: string | undefined
    if (typeof rgSearchWorkspace === 'function') {
      try {
        const rgResult = await rgSearchWorkspace.call(ctx, {
          query,
          path,
          regex: false,
          caseSensitive: true,
          globs: glob ? [glob] : undefined,
          contextLines: 0,
          maxMatches,
        })
        if (rgResult.ok) {
          return {
            ok: true,
            data: {
              matches: rgResult.matches.map((match) => ({
                path: match.path,
                line: match.line,
                lineNumber: match.lineNumber,
              })),
              truncated: rgResult.truncated,
            } satisfies SearchWorkspaceFilesResult,
          }
        }
        rgFailure = rgResult
      } catch (error) {
        // A missing/broken ripgrep bridge must not disable the built-in
        // literal search backend.
        rgError = toErrorMessage(error)
      }
    }

    try {
      if (typeof searchWorkspaceFiles === 'function') {
        const result = await searchWorkspaceFiles.call(ctx, { query, path, glob, maxMatches })
        return toToolResult(result)
      }
      return {
        ok: false,
        error:
          rgFailure?.stderr
          || rgError
          || `rg_search exited with code ${rgFailure?.exitCode ?? -1}`,
        code: 'SEARCH_FILES_FAILED',
        retryable: false,
        details: rgFailure ?? (rgError ? { backend: 'ripgrep', error: rgError } : undefined),
      }
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'SEARCH_FILES_FAILED',
        retryable: false,
        details: rgFailure ?? (rgError ? { backend: 'ripgrep', error: rgError } : undefined),
      }
    }
  },
}
