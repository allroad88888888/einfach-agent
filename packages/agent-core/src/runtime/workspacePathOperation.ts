import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  normalizeChangeSummary,
  type WorkspaceChangeContext,
  type WorkspaceChangeSummary,
} from './workspaceChange'

export interface WorkspacePathOperationInput {
  source: string
  destination: string
  workspaceRoot?: string
  changeContext?: WorkspaceChangeContext
}

export interface WorkspacePathOperationResult {
  ok: boolean
  source: string
  destination: string
  operation: 'copy' | 'move'
  reversible: boolean
  error?: string
  changeSet?: WorkspaceChangeSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function operate(
  operation: 'copy' | 'move',
  input: WorkspacePathOperationInput,
): Promise<WorkspacePathOperationResult> {
  const failed = (error: string): WorkspacePathOperationResult => ({
    ok: false,
    source: input.source,
    destination: input.destination,
    operation,
    reversible: false,
    error,
  })
  if (!isTauri()) return failed(`Workspace ${operation} is only available in the Tauri desktop runtime`)
  try {
    const raw = await invoke<unknown>(`${operation}_workspace_path`, {
      source: input.source,
      destination: input.destination,
      workspace_root: input.workspaceRoot,
      change_context: input.changeContext,
    })
    if (!isRecord(raw)) return failed(`${operation}_workspace_path returned an invalid response`)
    const result: WorkspacePathOperationResult = {
      ok: raw.ok === true,
      source: typeof raw.source === 'string' ? raw.source : input.source,
      destination: typeof raw.destination === 'string' ? raw.destination : input.destination,
      operation,
      reversible: raw.reversible === true,
    }
    if (typeof raw.error === 'string') result.error = raw.error
    const changeSet = normalizeChangeSummary(raw.changeSet ?? raw.change_set)
    if (changeSet) result.changeSet = changeSet
    return result
  } catch (error) {
    return failed(`${operation}_workspace_path failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const copyWorkspacePath = (input: WorkspacePathOperationInput) => operate('copy', input)
export const moveWorkspacePath = (input: WorkspacePathOperationInput) => operate('move', input)
