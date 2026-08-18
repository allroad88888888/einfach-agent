import { hasHostBridge, loadHostInvoke } from './hostBridge'
import {
  normalizeChangeSummary,
  type WorkspaceChangeContext,
  type WorkspaceChangeSummary,
} from './workspaceChange'

export interface WorkspaceDeleteInput {
  path: string
  recursive?: boolean
  workspaceRoot?: string
  /** Runtime-only audit metadata; tool arguments cannot provide this. */
  changeContext?: WorkspaceChangeContext
}

export interface WorkspaceDeleteResult {
  ok: boolean
  path: string
  deleted: boolean
  kind?: 'file' | 'directory'
  reversible: boolean
  error?: string
  changeSet?: WorkspaceChangeSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failed(input: WorkspaceDeleteInput, error: string): WorkspaceDeleteResult {
  return {
    ok: false,
    path: input.path,
    deleted: false,
    reversible: false,
    error,
  }
}

export async function deleteWorkspacePath(input: WorkspaceDeleteInput): Promise<WorkspaceDeleteResult> {
  if (!hasHostBridge()) {
    return failed(input, 'Workspace deletion is only available in the Tauri desktop runtime')
  }
  try {
    const invoke = await loadHostInvoke()
    const raw = await invoke<unknown>('delete_workspace_path', {
      path: input.path,
      recursive: input.recursive,
      workspace_root: input.workspaceRoot,
      change_context: input.changeContext,
    })
    if (!isRecord(raw)) return failed(input, 'delete_workspace_path returned an invalid response')
    const result: WorkspaceDeleteResult = {
      ok: raw.ok === true,
      path: typeof raw.path === 'string' ? raw.path : input.path,
      deleted: raw.deleted === true,
      reversible: raw.reversible === true,
    }
    if (raw.kind === 'file' || raw.kind === 'directory') result.kind = raw.kind
    if (typeof raw.error === 'string' && raw.error) result.error = raw.error
    const changeSet = normalizeChangeSummary(raw.changeSet ?? raw.change_set)
    if (changeSet) result.changeSet = changeSet
    return result
  } catch (error) {
    return failed(
      input,
      `delete_workspace_path failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
