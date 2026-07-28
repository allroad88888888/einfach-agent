import type { ShellCommandResult, ToolResult } from '@web-agent/core/tools/types'

// 后台进程握着 stdout/stderr 会让调用无法返回，宿主为此杀掉了整个进程组。
// 必须显式告诉模型：它用 `cmd &` 起的服务并没有活下来，后续步骤不能假设端口已就绪。
const BACKGROUND_KILLED_WARNING =
  '该命令留下的后台进程仍占用 stdout/stderr，已被强制终止。用 `cmd &` 启动的服务没有存活；' +
  '需要长期运行的服务请改用独立的任务/服务机制，或让命令自身以脱离终端的方式守护化。'

// 成功走 warnings、失败走 hint —— 两条路径都会随工具结果进入模型上下文。
function withBackgroundNotice(result: ShellCommandResult, toolResult: ToolResult): ToolResult {
  if (!result.backgroundProcessesKilled || !('ok' in toolResult)) {
    return toolResult
  }
  if (toolResult.ok) {
    return {
      ...toolResult,
      warnings: [...(toolResult.warnings ?? []), BACKGROUND_KILLED_WARNING],
    }
  }
  return {
    ...toolResult,
    hint: [toolResult.hint, BACKGROUND_KILLED_WARNING].filter(Boolean).join(' '),
  }
}

export function shellCommandToolResult(result: ShellCommandResult): ToolResult {
  if (result.timedOut) {
    return withBackgroundNotice(result, {
      ok: false,
      error: `shell command timed out after ${result.durationMs}ms`,
      code: 'SHELL_TIMEOUT',
      retryable: true,
      details: result,
    })
  }
  if (result.exitCode !== 0) {
    const commandNotFound = result.exitCode === 127
    return withBackgroundNotice(result, {
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
    })
  }
  return withBackgroundNotice(result, { ok: true, data: result })
}
