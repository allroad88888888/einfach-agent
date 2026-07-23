// tools/rg-search/rg-search.ts —— ripgrep-backed workspace code search. Side effects only go through ctx.
import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import type { RgSearchInput, RgSearchResult } from '@web-agent/core/runtime/workspaceRg'
import {
  DEFAULT_RG_CONTEXT_LINES,
  DEFAULT_RG_MAX_MATCHES,
  MAX_RG_CONTEXT_LINES,
  MAX_RG_MATCHES,
} from '@web-agent/core/runtime/workspaceRg'
import guide from './rg-search.md?raw'

type RgSearchContext = ToolContext & {
  rgSearchWorkspace(input: RgSearchInput): Promise<RgSearchResult>
}

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    path: { type: 'string', default: '.' },
    regex: { type: 'boolean', default: false },
    caseSensitive: { type: 'boolean', default: true },
    globs: {
      type: 'array',
      items: { type: 'string' },
    },
    contextLines: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_RG_CONTEXT_LINES,
      default: DEFAULT_RG_CONTEXT_LINES,
    },
    maxMatches: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_RG_MATCHES,
      default: DEFAULT_RG_MAX_MATCHES,
    },
  },
  required: ['query'],
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeBoolean(value: unknown, fallback: boolean, name: string): boolean | string {
  if (value === undefined) return fallback
  return typeof value === 'boolean' ? value : `invalid rg_search: ${name} must be a boolean`
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number, name: string): number | string {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `invalid rg_search: ${name} must be a non-negative number`
  }
  if (name !== 'contextLines' && value <= 0) {
    return `invalid rg_search: ${name} must be a positive number`
  }
  return Math.min(Math.floor(value), max)
}

function normalizeGlobs(value: unknown): string[] | undefined | string {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return 'invalid rg_search: globs must be an array of strings'

  const globs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return 'invalid rg_search: globs must be an array of strings'
    const glob = entry.trim()
    if (!glob) continue
    globs.push(glob)
  }
  return globs.length > 0 ? globs : undefined
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'rgSearchWorkspace failed'
}

function getRgSearchFromContext(ctx: ToolContext): RgSearchContext['rgSearchWorkspace'] | undefined {
  const candidate = (ctx as Partial<RgSearchContext>).rgSearchWorkspace
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

export const rgSearchTool: Tool = {
  name: 'rg_search',
  runtime: 'server', // 依赖 Tauri + ripgrep（ctx.rgSearchWorkspace），web 下不进 manifest（TP3）。
  skill: {
    description: '用 ripgrep 在 workspace 内执行高性能代码搜索（支持正则、glob、上下文行）。',
    triggers: ['rg', 'ripgrep', 'grep', '搜索代码', '代码搜索'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const value = asRecord(args)
    const query = typeof value.query === 'string' ? value.query.trim() : ''
    if (!query) {
      return { ok: false, error: 'invalid rg_search: query (non-empty string) is required' }
    }

    const path = typeof value.path === 'string' && value.path.trim() ? value.path.trim() : undefined
    const regex = normalizeBoolean(value.regex, false, 'regex')
    if (typeof regex === 'string') return { ok: false, error: regex }
    const caseSensitive = normalizeBoolean(value.caseSensitive, true, 'caseSensitive')
    if (typeof caseSensitive === 'string') return { ok: false, error: caseSensitive }
    const contextLines = normalizePositiveInteger(
      value.contextLines,
      DEFAULT_RG_CONTEXT_LINES,
      MAX_RG_CONTEXT_LINES,
      'contextLines',
    )
    if (typeof contextLines === 'string') return { ok: false, error: contextLines }
    const maxMatches = normalizePositiveInteger(
      value.maxMatches,
      DEFAULT_RG_MAX_MATCHES,
      MAX_RG_MATCHES,
      'maxMatches',
    )
    if (typeof maxMatches === 'string') return { ok: false, error: maxMatches }
    const globs = normalizeGlobs(value.globs)
    if (typeof globs === 'string') return { ok: false, error: globs }

    const rgSearchWorkspace = getRgSearchFromContext(ctx)
    if (!rgSearchWorkspace) {
      return { ok: false, error: 'rg_search unavailable: ctx.rgSearchWorkspace is not configured' }
    }

    try {
      const result = await rgSearchWorkspace({
        query,
        path,
        regex,
        caseSensitive,
        globs,
        contextLines,
        maxMatches,
      })
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
