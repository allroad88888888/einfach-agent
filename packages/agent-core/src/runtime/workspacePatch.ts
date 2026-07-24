import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  normalizeChangeSummary,
  type WorkspaceChangeContext,
  type WorkspaceChangeSummary,
} from './workspaceChange'

export type WorkspacePatchOperation =
  | { type: 'add_file'; path: string; content: string }
  | { type: 'delete_file'; path: string; oldContent?: string }
  | {
      type: 'replace'
      path: string
      oldText: string
      newText: string
      expectedReplacements?: number
    }
  | { type: 'overwrite_file'; path: string; content: string; oldContent?: string }

export interface WorkspacePatchInput {
  operations: WorkspacePatchOperation[]
  dryRun?: boolean
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only audit metadata; tool arguments cannot provide this. */
  changeContext?: WorkspaceChangeContext
}

export interface WorkspacePatchRejected {
  index: number
  operation: string
  path?: string
  reason: string
}

export interface WorkspacePatchResult {
  ok: boolean
  changedFiles: string[]
  rejected: WorkspacePatchRejected[]
  dryRun: boolean
  wouldChange: boolean
  summary: string
  changeSet?: WorkspaceChangeSummary
}

type TauriWorkspacePatchInput = {
  operations: WorkspacePatchOperation[]
  dry_run?: boolean
  workspace_root?: string
  change_context?: WorkspaceChangeContext
}

function toTauriInput(input: WorkspacePatchInput): TauriWorkspacePatchInput {
  return {
    operations: input.operations,
    dry_run: input.dryRun,
    workspace_root: input.workspaceRoot,
    change_context: input.changeContext,
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

function failedResult(input: WorkspacePatchInput, reason: string): WorkspacePatchResult {
  const result: WorkspacePatchResult = {
    ok: false,
    changedFiles: [],
    rejected: [{ index: -1, operation: 'runtime', reason }],
    dryRun: input.dryRun === true,
    wouldChange: false,
    summary: reason,
  }
  return result
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
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function normalizeRejected(value: unknown): WorkspacePatchRejected[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((entry) => ({
    index: numberValue(entry.index, -1),
    operation: stringValue(entry.operation ?? entry.type, 'unknown'),
    path: typeof entry.path === 'string' ? entry.path : undefined,
    reason: stringValue(entry.reason, 'operation rejected'),
  }))
}

function normalizeResult(raw: unknown, input: WorkspacePatchInput): WorkspacePatchResult {
  if (!isRecord(raw)) {
    return failedResult(input, 'apply_workspace_patch returned an invalid response')
  }

  const dryRun = booleanValue(raw.dryRun ?? raw.dry_run, input.dryRun === true)
  const summary = stringValue(raw.summary, '')
  const rejected = normalizeRejected(raw.rejected)

  const result: WorkspacePatchResult = {
    ok: booleanValue(raw.ok, rejected.length === 0),
    changedFiles: stringArrayValue(raw.changedFiles ?? raw.changed_files),
    rejected,
    dryRun,
    wouldChange: booleanValue(raw.wouldChange ?? raw.would_change, false),
    summary,
  }
  const changeSet = normalizeChangeSummary(raw.changeSet ?? raw.change_set)
  if (changeSet) result.changeSet = changeSet
  return result
}

export async function applyWorkspacePatch(
  input: WorkspacePatchInput,
): Promise<WorkspacePatchResult> {
  if (!isTauri()) {
    return failedResult(
      input,
      'Workspace patching is only available in the Tauri desktop runtime',
    )
  }

  try {
    const raw = await invoke<unknown>('apply_workspace_patch', toTauriInput(input))
    return normalizeResult(raw, input)
  } catch (error) {
    return failedResult(input, `apply_workspace_patch failed: ${messageFromError(error)}`)
  }
}
