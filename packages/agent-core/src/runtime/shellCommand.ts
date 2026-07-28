import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ShellCommandInput, ShellCommandResult, ShellPlatform } from '../tools/types'

type TauriShellCommandInput = {
  platform: ShellPlatform
  command: string
  cwd?: string
  timeout_ms?: number
  max_output_chars?: number
  env?: Record<string, string>
}

function now(): number {
  return Date.now()
}

function durationSince(startedAt: number): number {
  return Math.max(0, now() - startedAt)
}

function toTauriInput(input: ShellCommandInput): TauriShellCommandInput {
  return {
    platform: input.platform,
    command: input.command,
    cwd: input.cwd,
    timeout_ms: input.timeoutMs,
    max_output_chars: input.maxOutputChars,
    env: input.env,
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

function failedResult(input: ShellCommandInput, startedAt: number, stderr: string): ShellCommandResult {
  return {
    platform: input.platform,
    shell: 'unavailable',
    command: input.command,
    cwd: input.cwd ?? '',
    exitCode: 1,
    stdout: '',
    stderr,
    durationMs: durationSince(startedAt),
    timedOut: false,
    truncated: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShellPlatform(value: unknown): value is ShellPlatform {
  return value === 'macos' || value === 'linux' || value === 'windows'
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

function normalizeResult(raw: unknown, input: ShellCommandInput, startedAt: number): ShellCommandResult {
  if (!isRecord(raw)) {
    return failedResult(input, startedAt, 'run_shell_command returned an invalid response')
  }

  const timedOut = booleanValue(raw.timedOut ?? raw.timed_out, false)
  const rawExitCode = raw.exitCode ?? raw.exit_code
  const validExitCode = typeof rawExitCode === 'number' && Number.isFinite(rawExitCode)
  const stderr = stringValue(raw.stderr, '')

  return {
    platform: isShellPlatform(raw.platform) ? raw.platform : input.platform,
    shell: stringValue(raw.shell, ''),
    command: stringValue(raw.command, input.command),
    cwd: stringValue(raw.cwd, input.cwd ?? ''),
    // A missing exit code is a malformed bridge response, never a successful command.
    exitCode: validExitCode ? rawExitCode : -1,
    stdout: stringValue(raw.stdout, ''),
    stderr: validExitCode
      ? stderr
      : [stderr, 'run_shell_command returned a response without a valid exit code']
          .filter(Boolean)
          .join('\n'),
    durationMs: numberValue(raw.durationMs ?? raw.duration_ms, durationSince(startedAt)),
    timedOut,
    truncated: booleanValue(raw.truncated, false),
    backgroundProcessesKilled: booleanValue(
      raw.backgroundProcessesKilled ?? raw.background_processes_killed,
      false,
    ),
  }
}

export async function runShellCommand(input: ShellCommandInput): Promise<ShellCommandResult> {
  const startedAt = now()

  if (!isTauri()) {
    return failedResult(input, startedAt, 'Shell command execution is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('run_shell_command', toTauriInput(input))
    return normalizeResult(raw, input, startedAt)
  } catch (error) {
    return failedResult(input, startedAt, `run_shell_command failed: ${messageFromError(error)}`)
  }
}
