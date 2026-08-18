import { hasHostBridge, loadHostInvoke } from './hostBridge'
import type { WorkspaceTaskInput, WorkspaceTaskKind, WorkspaceTaskResult } from '../tools/types'

export type { WorkspaceTaskInput, WorkspaceTaskKind, WorkspaceTaskResult } from '../tools/types'

export const DEFAULT_WORKSPACE_TASK_TIMEOUT_MS = 120_000
export const MAX_WORKSPACE_TASK_TIMEOUT_MS = 600_000
export const DEFAULT_WORKSPACE_TASK_MAX_OUTPUT_CHARS = 20_000
export const MAX_WORKSPACE_TASK_MAX_OUTPUT_CHARS = 100_000

type TauriWorkspaceTaskInput = {
  kind: WorkspaceTaskKind
  timeout_ms?: number
  max_output_chars?: number
  workspace_root?: string
}

function now(): number {
  return Date.now()
}

function durationSince(startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

function toTauriInput(input: WorkspaceTaskInput): TauriWorkspaceTaskInput {
  return {
    kind: input.kind,
    timeout_ms: input.timeoutMs,
    max_output_chars: input.maxOutputChars,
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

function failedResult(input: WorkspaceTaskInput, startedAt: number, stderr: string): WorkspaceTaskResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr,
    durationMs: durationSince(startedAt),
    timedOut: false,
    truncated: false,
    command: [],
    cwd: input.workspaceRoot ?? '',
    kind: input.kind,
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

function normalizeCommand(value: unknown): string[] {
  if (Array.isArray(value)) return stringArrayValue(value)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

function normalizeResult(raw: unknown, input: WorkspaceTaskInput, startedAt: number): WorkspaceTaskResult {
  if (!isRecord(raw)) {
    return failedResult(input, startedAt, 'run_workspace_task returned an invalid response')
  }

  const timedOut = booleanValue(raw.timedOut ?? raw.timed_out, false)

  return {
    ok: booleanValue(raw.ok, false),
    exitCode: numberValue(raw.exitCode ?? raw.exit_code, timedOut ? -1 : 1),
    stdout: stringValue(raw.stdout, ''),
    stderr: stringValue(raw.stderr, ''),
    durationMs: numberValue(raw.durationMs ?? raw.duration_ms, durationSince(startedAt)),
    timedOut,
    truncated: booleanValue(raw.truncated, false),
    command: normalizeCommand(raw.command),
    cwd: stringValue(raw.cwd, input.workspaceRoot ?? ''),
    kind: stringValue(raw.kind, input.kind),
  }
}

export async function runWorkspaceTask(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult> {
  const startedAt = now()

  if (!hasHostBridge()) {
    return failedResult(input, startedAt, 'run_workspace_task：当前宿主未提供命令桥')
  }

  try {
    const invoke = await loadHostInvoke()
    const raw = await invoke<unknown>('run_workspace_task', toTauriInput(input))
    return normalizeResult(raw, input, startedAt)
  } catch (error) {
    return failedResult(input, startedAt, `run_workspace_task failed: ${messageFromError(error)}`)
  }
}
