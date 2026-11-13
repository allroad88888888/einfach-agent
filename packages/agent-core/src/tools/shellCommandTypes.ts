/** Value objects for invoking a shell command through ToolContext. */
export type ShellPlatform = 'macos' | 'linux' | 'windows'

/**
 * Why a command was killed.
 *
 * `idle`  —— it produced no output for the whole idle window. It may be waiting or working silently.
 * `total` —— it hit the overall ceiling, regardless of recent output.
 *
 * The two call for different follow-up, which is why they are not collapsed into `timedOut`.
 * Absent on backends that only report a wall-clock deadline.
 */
export type ShellTimeoutReason = 'idle' | 'total'

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
  /** Present only when `timedOut` is true and the host reports a reason. */
  timeoutReason?: ShellTimeoutReason
  truncated: boolean
  /**
   * The command left background processes still holding stdout/stderr (`cmd &`),
   * and they were killed so the call could return. Nothing it backgrounded survives.
   */
  backgroundProcessesKilled?: boolean
  /** Present and false for shell deletion, which cannot produce a recoverable change set. */
  reversible?: false
}
