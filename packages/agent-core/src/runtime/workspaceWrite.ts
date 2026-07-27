import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  normalizeChangeSummary,
  type WorkspaceChangeContext,
  type WorkspaceChangeSummary,
} from './workspaceChange'

export type WorkspaceWriteMode = 'create' | 'overwrite' | 'append'

export interface WorkspaceWriteInput {
  path: string
  content: string
  mode?: WorkspaceWriteMode
  expectedOldContent?: string
  /** A contentHash returned by a complete readWorkspaceFile call. */
  expectedContentHash?: string
  createDirs?: boolean
  maxBytes?: number
  /** Serialize this target across app processes. Used by the subagent archive. */
  exclusivePathLock?: boolean
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only audit metadata; tool arguments cannot provide this. */
  changeContext?: WorkspaceChangeContext
}

export interface WorkspaceWriteResult {
  ok: boolean
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  appended: boolean
  error?: string
  changeSet?: WorkspaceChangeSummary
}

type TauriWorkspaceWriteInput = {
  path: string
  content: string
  mode?: WorkspaceWriteMode
  expected_old_content?: string
  expected_content_hash?: string
  create_dirs?: boolean
  max_bytes?: number
  exclusive_path_lock?: boolean
  workspace_root?: string
  change_context?: WorkspaceChangeContext
}

function toTauriInput(input: WorkspaceWriteInput): TauriWorkspaceWriteInput {
  return {
    path: input.path,
    content: input.content,
    mode: input.mode,
    expected_old_content: input.expectedOldContent,
    expected_content_hash: input.expectedContentHash,
    create_dirs: input.createDirs,
    max_bytes: input.maxBytes,
    exclusive_path_lock: input.exclusivePathLock,
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function failedResult(input: WorkspaceWriteInput, error: string): WorkspaceWriteResult {
  return {
    ok: false,
    path: input.path,
    bytesWritten: 0,
    created: false,
    overwritten: false,
    appended: false,
    error,
  }
}

function normalizeResult(raw: unknown, input: WorkspaceWriteInput): WorkspaceWriteResult {
  if (!isRecord(raw)) {
    return failedResult(input, 'write_workspace_file returned an invalid response')
  }

  const ok = booleanValue(raw.ok, false)
  const error = stringValue(raw.error, '')
  const result: WorkspaceWriteResult = {
    ok,
    path: stringValue(raw.path, input.path),
    bytesWritten: numberValue(raw.bytesWritten ?? raw.bytes_written, ok ? byteLength(input.content) : 0),
    created: booleanValue(raw.created, false),
    overwritten: booleanValue(raw.overwritten, false),
    appended: booleanValue(raw.appended, false),
  }
  if (!ok && error) {
    result.error = error
  }
  const changeSet = normalizeChangeSummary(raw.changeSet ?? raw.change_set)
  if (changeSet) result.changeSet = changeSet
  return result
}

export async function writeWorkspaceFile(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
  if (!isTauri()) {
    return failedResult(input, 'Workspace file writing is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('write_workspace_file', toTauriInput(input))
    return normalizeResult(raw, input)
  } catch (error) {
    return failedResult(input, `write_workspace_file failed: ${messageFromError(error)}`)
  }
}
