import { isTauriHost, loadTauriInvoke } from './hostTauri'

export const DEFAULT_MAX_DIFF_CHARS = 20_000
export const MAX_DIFF_CHARS = 100_000

export interface WorkspaceDiffInput {
  paths?: string[]
  staged?: boolean
  /** Optional commit/ref to compare against (for example `HEAD~1` or `origin/main`). */
  base?: string
  maxDiffChars?: number
  includeStat?: boolean
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
}

export interface WorkspaceDiffResult {
  base?: string
  statusShort: string
  stat?: string
  diff: string
  changedFiles: string[]
  truncated: boolean
  exitCode: number
  stderr: string
}

type TauriWorkspaceDiffInput = {
  paths?: string[]
  staged?: boolean
  base?: string
  max_diff_chars?: number
  include_stat?: boolean
  workspace_root?: string
}

function toTauriInput(input: WorkspaceDiffInput): TauriWorkspaceDiffInput {
  return {
    paths: input.paths,
    staged: input.staged,
    base: input.base,
    max_diff_chars: input.maxDiffChars,
    include_stat: input.includeStat,
    workspace_root: input.workspaceRoot,
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

function failedResult(stderr: string): WorkspaceDiffResult {
  return {
    statusShort: '',
    diff: '',
    changedFiles: [],
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

function normalizeResult(raw: unknown): WorkspaceDiffResult {
  if (!isRecord(raw)) {
    return failedResult('get_workspace_diff returned an invalid response')
  }

  const result: WorkspaceDiffResult = {
    statusShort: stringValue(raw.statusShort ?? raw.status_short, ''),
    diff: stringValue(raw.diff, ''),
    changedFiles: stringArrayValue(raw.changedFiles ?? raw.changed_files),
    truncated: booleanValue(raw.truncated, false),
    exitCode: numberValue(raw.exitCode ?? raw.exit_code, 0),
    stderr: stringValue(raw.stderr, ''),
  }

  const base = raw.base
  if (typeof base === 'string') {
    result.base = base
  }
  const stat = raw.stat
  if (typeof stat === 'string') {
    result.stat = stat
  }

  return result
}

export async function getWorkspaceDiff(input: WorkspaceDiffInput = {}): Promise<WorkspaceDiffResult> {
  if (!isTauriHost()) {
    return failedResult('Workspace git diff is only available in the Tauri desktop runtime')
  }

  try {
    const invoke = await loadTauriInvoke()
    const raw = await invoke<unknown>('get_workspace_diff', toTauriInput(input))
    return normalizeResult(raw)
  } catch (error) {
    return failedResult(`get_workspace_diff failed: ${messageFromError(error)}`)
  }
}
