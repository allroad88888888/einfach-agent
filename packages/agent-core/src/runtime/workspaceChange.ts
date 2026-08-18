import { hasHostBridge, loadHostInvoke } from './hostBridge'

export interface WorkspaceChangeContext {
  changeId: string
  sessionId: string
  runId: string
  toolCallId: string
}

export interface WorkspaceChangeSummary {
  id: string
  reversible: boolean
}

export interface WorkspaceRevertInput {
  changeSetId?: string
  /** Change sets in execution order; rollback applies them in reverse order atomically. */
  changeSetIds?: string[]
  dryRun?: boolean
  workspaceRoot?: string
}

export interface WorkspaceChangeConflict {
  path: string
  reason: string
}

export interface WorkspaceRevertResult {
  ok: boolean
  status: 'ready' | 'batch_ready' | 'reverted' | 'batch_reverted' | 'already_reverted' | 'conflict' | 'workspace_mismatch' | 'missing_payload' | 'failed'
  restoredFiles: string[]
  conflicts: WorkspaceChangeConflict[]
  error?: string
  revertedChangeSetIds?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeChangeSummary(value: unknown): WorkspaceChangeSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.reversible !== 'boolean') {
    return undefined
  }
  return { id: value.id, reversible: value.reversible }
}

function failed(error: string): WorkspaceRevertResult {
  return { ok: false, status: 'failed', restoredFiles: [], conflicts: [], error }
}

export async function revertWorkspaceChange(
  input: WorkspaceRevertInput,
): Promise<WorkspaceRevertResult> {
  if (!hasHostBridge()) {
    return failed('Workspace rollback is only available in the Tauri desktop runtime')
  }
  try {
    const invoke = await loadHostInvoke()
    const raw = await invoke<unknown>('revert_workspace_change', {
      change_set_id: input.changeSetId,
      change_set_ids: input.changeSetIds,
      dry_run: input.dryRun,
      workspace_root: input.workspaceRoot,
    })
    if (!isRecord(raw)) return failed('revert_workspace_change returned an invalid response')
    const conflicts = Array.isArray(raw.conflicts)
      ? raw.conflicts.filter(isRecord).map((entry) => ({
          path: typeof entry.path === 'string' ? entry.path : '',
          reason: typeof entry.reason === 'string' ? entry.reason : 'file changed',
        }))
      : []
    const rawRestoredFiles = raw.restoredFiles ?? raw.restored_files
    const restoredFiles = Array.isArray(rawRestoredFiles)
      ? rawRestoredFiles.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : []
    const result: WorkspaceRevertResult = {
      ok: raw.ok === true,
      status: typeof raw.status === 'string'
        ? raw.status as WorkspaceRevertResult['status']
        : 'failed',
      restoredFiles,
      conflicts,
    }
    if (typeof raw.error === 'string') result.error = raw.error
    const rawIds = raw.revertedChangeSetIds ?? raw.reverted_change_set_ids
    if (Array.isArray(rawIds)) {
      result.revertedChangeSetIds = rawIds.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    }
    return result
  } catch (error) {
    return failed(
      `revert_workspace_change failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
