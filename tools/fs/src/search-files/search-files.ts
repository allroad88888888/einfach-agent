import type { Tool, ToolContext, ToolResult } from '@web-agent/core/tools/types'
import type {
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
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
}

type MaybeWorkspaceResult<T> = WorkspaceRuntimeResult<T> | T

type WorkspaceSearchContext = ToolContext & {
  searchWorkspaceFiles(input: SearchWorkspaceFilesInput): Promise<MaybeWorkspaceResult<SearchWorkspaceFilesResult>>
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
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }
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
    description: '在 workspace 内按普通字符串搜索文本文件。',
    triggers: ['search files', '搜索文件', '查找文本', 'grep'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) {
      return { ok: false, error: 'invalid search_files: query (non-empty string) is required' }
    }

    const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
    const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : undefined
    const maxMatches = normalizePositiveInteger(input.maxMatches, DEFAULT_MAX_MATCHES, MAX_MATCHES)
    const searchWorkspaceFiles = (ctx as Partial<WorkspaceSearchContext>).searchWorkspaceFiles
    if (typeof searchWorkspaceFiles !== 'function') {
      return { ok: false, error: 'search_files is unavailable: ctx.searchWorkspaceFiles is not configured' }
    }

    try {
      const result = await searchWorkspaceFiles.call(ctx, { query, path, glob, maxMatches })
      return toToolResult(result)
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
