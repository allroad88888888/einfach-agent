/** Value objects for invoking a shell command through ToolContext. */
export type ShellPlatform = 'macos' | 'linux' | 'windows'

export interface ShellCommandInput {
  platform: ShellPlatform
  command: string
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
  env?: Record<string, string>
}

export interface ShellCommandResult {
  platform: ShellPlatform
  shell: string
  command: string
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  /**
   * The command left background processes still holding stdout/stderr (`cmd &`),
   * and they were killed so the call could return. Nothing it backgrounded survives.
   */
  backgroundProcessesKilled?: boolean
  /** Present and false for shell deletion, which cannot produce a recoverable change set. */
  reversible?: false
}
