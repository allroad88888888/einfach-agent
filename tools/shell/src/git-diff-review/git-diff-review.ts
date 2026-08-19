// tools/git-diff-review/git-diff-review.ts —— 只读 Git diff review 工具。副作用只经 ctx.getWorkspaceDiff。
import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import guide from './git-diff-review.md?raw'

const DEFAULT_MAX_DIFF_CHARS = 20_000
const MAX_DIFF_CHARS = 100_000

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

type GetWorkspaceDiff = (input: WorkspaceDiffInput) => Promise<WorkspaceDiffResult>

type NormalizedInput =
  | { ok: true; input: WorkspaceDiffInput }
  | { ok: false; error: string }

const inputSchema = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
    },
    staged: { type: 'boolean', default: false },
    base: {
      type: 'string',
      description: 'Optional commit or ref to compare against, such as HEAD~1 or origin/main.',
    },
    maxDiffChars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_DIFF_CHARS,
      default: DEFAULT_MAX_DIFF_CHARS,
    },
    includeStat: { type: 'boolean', default: true },
  },
  additionalProperties: false,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'getWorkspaceDiff failed'
}

function normalizeBoolean(value: unknown, fallback: boolean, name: string): boolean | string {
  if (value === undefined) return fallback
  return typeof value === 'boolean' ? value : `invalid git_diff_review: ${name} must be a boolean`
}

function normalizeMaxDiffChars(value: unknown): number | string {
  if (value === undefined) return DEFAULT_MAX_DIFF_CHARS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'invalid git_diff_review: maxDiffChars must be a positive number'
  }
  return Math.min(Math.floor(value), MAX_DIFF_CHARS)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function normalizePath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  if (!trimmed || trimmed.includes('\0') || isAbsolutePath(trimmed)) return undefined

  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0 || segments.includes('..')) return undefined

  return trimmed
}

function normalizePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined

  const paths: string[] = []
  for (const entry of value) {
    const path = normalizePath(entry)
    if (!path) return undefined
    paths.push(path)
  }
  return paths
}

function normalizeInput(args: unknown): NormalizedInput {
  const value = asRecord(args)
  const paths = normalizePaths(value.paths)
  if (value.paths !== undefined && !paths) {
    return {
      ok: false,
      error: 'invalid git_diff_review: paths must be workspace-relative strings without parent traversal',
    }
  }

  const staged = normalizeBoolean(value.staged, false, 'staged')
  if (typeof staged === 'string') return { ok: false, error: staged }

  const includeStat = normalizeBoolean(value.includeStat, true, 'includeStat')
  if (typeof includeStat === 'string') return { ok: false, error: includeStat }

  const maxDiffChars = normalizeMaxDiffChars(value.maxDiffChars)
  if (typeof maxDiffChars === 'string') return { ok: false, error: maxDiffChars }

  let base: string | undefined
  if (value.base !== undefined) {
    if (typeof value.base !== 'string') {
      return { ok: false, error: 'invalid git_diff_review: base must be a string' }
    }
    base = value.base.trim()
    if (
      !base
      || base.startsWith('-')
      || [...base].some((character) => /\s/.test(character) || character.charCodeAt(0) < 32)
    ) {
      return {
        ok: false,
        error: 'invalid git_diff_review: base must be a ref or commit without leading `-`, whitespace, or control characters',
      }
    }
  }

  return {
    ok: true,
    input: {
      paths,
      staged,
      base,
      maxDiffChars,
      includeStat,
    },
  }
}

function getWorkspaceDiffFromContext(ctx: ToolContext): GetWorkspaceDiff | undefined {
  const candidate = (ctx as ToolContext & { getWorkspaceDiff?: GetWorkspaceDiff }).getWorkspaceDiff
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

export const gitDiffReviewTool: Tool = {
  name: 'git_diff_review',
  execution: { mode: 'parallel', effectKeys: ['workspace:read', 'git:read'] },
  runtime: 'server', // 依赖 Tauri Git（ctx.getWorkspaceDiff），web 下不进 manifest（TP3）。
  skill: {
    description: '只读检查当前 Git 工作区状态、变更文件、diff stat 和 diff 内容。',
    triggers: ['git', 'diff', 'review', '提交前检查', '变更检查'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const normalized = normalizeInput(args)
    if (!normalized.ok) {
      return {
        ok: false,
        error: normalized.error,
        code: 'GIT_DIFF_INVALID_INPUT',
        retryable: false,
      }
    }

    const getWorkspaceDiff = getWorkspaceDiffFromContext(ctx)
    if (!getWorkspaceDiff) {
      return {
        ok: false,
        error: 'git_diff_review unavailable: ctx.getWorkspaceDiff is not configured',
        code: 'GIT_DIFF_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      const result = await getWorkspaceDiff(normalized.input)
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: result.stderr || `git_diff_review exited with code ${result.exitCode}`,
          code: 'GIT_DIFF_FAILED',
          retryable: false,
          details: result,
        }
      }
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'GIT_DIFF_FAILED',
        retryable: false,
      }
    }
  },
}
