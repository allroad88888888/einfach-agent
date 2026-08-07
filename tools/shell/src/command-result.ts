import type { ShellCommandResult, ToolResult } from '@web-agent/core/tools/types'

// 后台进程握着 stdout/stderr 会让调用无法返回，宿主为此杀掉了整个进程组。
// 必须显式告诉模型：它用 `cmd &` 起的服务并没有活下来，后续步骤不能假设端口已就绪。
const BACKGROUND_KILLED_WARNING =
  '该命令留下的后台进程仍占用 stdout/stderr，已被强制终止。用 `cmd &` 启动的服务没有存活；' +
  '需要长期运行的服务请改用独立的任务/服务机制，或让命令自身以脱离终端的方式守护化。'

const FAILURE_OUTPUT_PREVIEW_LENGTH = 600

function outputPreview(output: string): string {
  const normalized = output.trim()
  if (normalized.length <= FAILURE_OUTPUT_PREVIEW_LENGTH) return normalized
  return `${normalized.slice(0, FAILURE_OUTPUT_PREVIEW_LENGTH)}…（完整输出见 details）`
}

function usesTextSearch(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:command\s+)?(?:grep|rg)\b/i.test(command)
}

function nonZeroExitHint(result: ShellCommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim()
  const source = result.stderr.trim() ? 'stderr' : 'stdout'
  const parts = output
    ? [`${source}: ${outputPreview(output)}`]
    : ['命令没有输出 stdout 或 stderr。']

  if (result.truncated) {
    parts.push('输出已截断；完整诊断需要缩小命令范围或提高 maxOutputChars。')
  }
  if (result.exitCode === 1 && usesTextSearch(result.command)) {
    parts.push(
      '该命令包含 grep/rg：exit 1 可能仅表示无匹配；通用 shell 无法安全判断复合命令中是哪一段退出。工作区文本搜索请改用 rg_search 或 search_files，它们会把无匹配作为正常空结果返回。',
    )
  }
  return parts.join(' ')
}

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
        : nonZeroExitHint(result),
      retryable: false,
      details: result,
    })
  }
  return withBackgroundNotice(result, { ok: true, data: result })
}
