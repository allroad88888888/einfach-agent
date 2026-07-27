import type { ShellCommandResult, ToolResult } from '@web-agent/core/tools/types'

export function shellCommandToolResult(result: ShellCommandResult): ToolResult {
  if (result.timedOut) {
    return {
      ok: false,
      error: `shell command timed out after ${result.durationMs}ms`,
      code: 'SHELL_TIMEOUT',
      retryable: true,
      details: result,
    }
  }
  if (result.exitCode !== 0) {
    const commandNotFound = result.exitCode === 127
    return {
      ok: false,
      error: commandNotFound
        ? `shell could not find a command (exit 127) using ${result.shell} in ${result.cwd}`
        : `shell command exited with code ${result.exitCode}`,
      code: commandNotFound ? 'SHELL_COMMAND_NOT_FOUND' : 'SHELL_EXIT_NONZERO',
      hint: commandNotFound
        ? 'Check the command name, executable permission, working directory, and PATH inside this non-interactive shell. Use `command -v <name>` and print `$PATH` in the same shell to diagnose it.'
        : undefined,
      retryable: false,
      details: result,
    }
  }
  return { ok: true, data: result }
}
