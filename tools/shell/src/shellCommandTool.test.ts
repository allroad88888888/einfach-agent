import { describe, expect, it, vi } from 'vitest'
import type { ShellCommandInput, ShellCommandResult, ToolContext } from '@einfach-agent/core/tools'
import { shellLinuxTool } from './shell-linux/shell-linux'
import { shellMacosTool } from './shell-macos/shell-macos'
import { shellPowershellTool } from './shell-powershell/shell-powershell'

const shellTools = [
  { name: 'shell_macos', platform: 'macos', tool: shellMacosTool },
  { name: 'shell_linux', platform: 'linux', tool: shellLinuxTool },
  { name: 'shell_powershell', platform: 'windows', tool: shellPowershellTool },
] as const

function makeShellResult(
  input: ShellCommandInput,
  overrides: Partial<ShellCommandResult> = {},
): ShellCommandResult {
  return {
    platform: input.platform,
    shell: 'test-shell',
    command: input.command,
    cwd: input.cwd ?? '/workspace',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  }
}

function makeContext(runShell: ToolContext['runShell']): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    runShell,
  }
}

function contextWithoutShell(): ToolContext {
  const context = makeContext(vi.fn()) as unknown as Record<string, unknown>
  delete context.runShell
  return context as unknown as ToolContext
}

describe.each(shellTools)('$name shared shell execution contract', ({ name, platform, tool }) => {
  it('没有 runShell capability → 保留统一执行错误语义', async () => {
    const result = await tool.execute({ command: 'pwd' }, contextWithoutShell())

    expect(result).toMatchObject({
      ok: false,
      code: 'SHELL_EXECUTION_ERROR',
      retryable: true,
      error: expect.any(String),
    })
  })

  it('危险文件写 → 被拒绝且不执行', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))

    const result = await tool.execute({ command: "printf 'next' > src/a.ts" }, makeContext(runShell))

    expect(result).toEqual({
      ok: false,
      code: 'shell_file_write_rejected',
      error: `${name} rejected: detected file modification via shell (shell output redirection writes a file)`,
      hint: 'Use write_file for text file writes, or apply_patch for targeted edits to existing files. Shell commands must not write file contents directly.',
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('timeout → 统一映射为可重试的 SHELL_TIMEOUT', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input, {
      timedOut: true,
      durationMs: 1_000,
    }))

    const result = await tool.execute({ command: 'sleep 1' }, makeContext(runShell))

    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({ platform }))
    expect(result).toMatchObject({
      ok: false,
      code: 'SHELL_TIMEOUT',
      retryable: true,
      error: 'shell command timed out after 1000ms',
    })
  })

  it('非零退出 → 统一映射为 SHELL_EXIT_NONZERO', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input, {
      exitCode: 2,
      stderr: 'failed',
    }))

    const result = await tool.execute({ command: 'false' }, makeContext(runShell))

    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({ platform }))
    expect(result).toMatchObject({
      ok: false,
      code: 'SHELL_EXIT_NONZERO',
      retryable: false,
      error: 'shell command exited with code 2',
    })
  })

  it('成功输出 → 统一返回原始 shell result', async () => {
    const expected = makeShellResult(
      { platform, command: 'echo ok' },
      { stdout: 'ok\n' },
    )
    const runShell = vi.fn(async () => expected)

    const result = await tool.execute({ command: '  echo ok  ' }, makeContext(runShell))

    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({
      platform,
      command: 'echo ok',
      timeoutMs: 30_000,
      maxOutputChars: 20_000,
    }))
    expect(result).toEqual({ ok: true, data: expected })
  })

  it('平台 descriptor 保留原工具名与 guide', () => {
    expect(tool).toMatchObject({ name, runtime: 'server', replayUnsafe: true })
    expect(tool.skill.content.length).toBeGreaterThan(0)
  })
})
