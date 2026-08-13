import { isTauriHost, loadTauriInvoke } from './hostTauri'

export const DEFAULT_RG_MAX_MATCHES = 200
export const MAX_RG_MATCHES = 1_000
export const DEFAULT_RG_CONTEXT_LINES = 0
export const MAX_RG_CONTEXT_LINES = 5

export interface RgSearchInput {
  query: string
  path?: string
  regex?: boolean
  caseSensitive?: boolean
  globs?: string[]
  contextLines?: number
  maxMatches?: number
  /** 可选显式 workspace root；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only：Auto 会话允许搜索 workspace 外路径；工具参数不能提供此字段。 */
  allowExternalPaths?: boolean
}

export interface RgSearchMatch {
  path: string
  lineNumber: number
  column: number
  line: string
  before: string[]
  after: string[]
}

export interface RgSearchResult {
  ok: boolean
  matches: RgSearchMatch[]
  truncated: boolean
  exitCode: number
  stderr: string
}

type TauriRgSearchInput = {
  query: string
  path?: string
  regex?: boolean
  case_sensitive?: boolean
  globs?: string[]
  context_lines?: number
  max_matches?: number
  workspace_root?: string
  allow_external_paths?: boolean
}

function toTauriInput(input: RgSearchInput): TauriRgSearchInput {
  return {
    query: input.query,
    path: input.path,
    regex: input.regex,
    case_sensitive: input.caseSensitive,
    globs: input.globs,
    context_lines: input.contextLines,
    max_matches: input.maxMatches,
    workspace_root: input.workspaceRoot,
    allow_external_paths: input.allowExternalPaths,
  }
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function failedResult(stderr: string): RgSearchResult {
  return {
    ok: false,
    matches: [],
    truncated: false,
    exitCode: 1,
    stderr,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function normalizeMatches(value: unknown): RgSearchMatch[] {
  if (!Array.isArray(value)) return []
  const matches: RgSearchMatch[] = []

  for (const item of value) {
    if (!isRecord(item)) continue
    const path = stringValue(item.path, '')
    const lineNumber = numberValue(item.lineNumber ?? item.line_number, 0)
    const line = stringValue(item.line, '')
    if (!path || lineNumber <= 0) continue
    matches.push({
      path,
      lineNumber,
      column: numberValue(item.column, 1),
      line,
      before: stringArrayValue(item.before),
      after: stringArrayValue(item.after),
    })
  }

  return matches
}

function normalizeResult(raw: unknown): RgSearchResult {
  if (!isRecord(raw)) {
    return failedResult('rg_search_workspace returned an invalid response')
  }

  return {
    ok: booleanValue(raw.ok, false),
    matches: normalizeMatches(raw.matches),
    truncated: booleanValue(raw.truncated, false),
    exitCode: numberValue(raw.exitCode ?? raw.exit_code, 1),
    stderr: stringValue(raw.stderr, ''),
  }
}

export async function rgSearchWorkspace(input: RgSearchInput): Promise<RgSearchResult> {
  if (!isTauriHost()) {
    return failedResult('rg_search is only available in the Tauri desktop runtime')
  }

  try {
    const invoke = await loadTauriInvoke()
    const raw = await invoke<unknown>('rg_search_workspace', toTauriInput(input))
    return normalizeResult(raw)
  } catch (error) {
    return failedResult(`rg_search_workspace failed: ${messageFromError(error)}`)
  }
}
