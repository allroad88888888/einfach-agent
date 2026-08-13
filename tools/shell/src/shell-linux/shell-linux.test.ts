import { describe, it, expect, vi } from 'vitest'
import type { ShellCommandInput, ShellCommandResult, ToolContext } from '@web-agent/core/tools'
import { shellLinuxTool } from './shell-linux'

function makeShellResult(
  input: ShellCommandInput,
  overrides: Partial<ShellCommandResult> = {},
): ShellCommandResult {
  return {
    platform: input.platform,
    shell: 'test',
    command: input.command,
    cwd: input.cwd ?? '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  }
}

function makeCtx(runShell: ToolContext['runShell'] = vi.fn(async (input) => makeShellResult(input))) {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    runShell,
  }
}

describe('shell_linux tool', () => {
  it('合法参数 → ctx.runShell 被调用，返回 {ok:true, data}', async () => {
    const shellResult = makeShellResult(
      { platform: 'linux', command: 'pwd', cwd: '/tmp' },
      { stdout: 'ok' },
    )
    const runShell = vi.fn(async () => shellResult)
    const ctx = makeCtx(runShell)

    const result = await shellLinuxTool.execute(
      {
        command: '  pwd  ',
        cwd: '  /tmp  ',
        timeoutMs: 1000,
        maxOutputChars: 5000,
        env: { A: '1', B: 2, EMPTY: '' },
      },
      ctx,
    )

    expect(runShell).toHaveBeenCalledWith({
      platform: 'linux',
      command: 'pwd',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputChars: 5000,
      env: { A: '1', EMPTY: '' },
    })
    expect(result).toEqual({ ok: true, data: shellResult })
  })

  it('非法 command → {ok:false}，且不调 runShell', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellLinuxTool.execute({ command: '   ' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid shell_linux: command (non-empty string) is required',
      code: 'SHELL_INVALID_INPUT',
      retryable: false,
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('文件写命令被拒绝并引导使用 write_file', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellLinuxTool.execute(
      { command: `python3 -c "open('src/a.ts', 'w').write('next')"` },
      ctx,
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'shell_file_write_rejected',
      hint: expect.stringContaining('write_file'),
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('timeoutMs/maxOutputChars 使用默认值并执行上限 clamp', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellLinuxTool.execute({ command: 'id' }, ctx)
    await shellLinuxTool.execute(
      { command: 'id', timeoutMs: 999_999, maxOutputChars: 999_999 },
      ctx,
    )

    expect(runShell).toHaveBeenNthCalledWith(1, {
      platform: 'linux',
      command: 'id',
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputChars: 20_000,
      env: undefined,
    })
    expect(runShell).toHaveBeenNthCalledWith(2, {
      platform: 'linux',
      command: 'id',
      cwd: undefined,
      timeoutMs: 120_000,
      maxOutputChars: 100_000,
      env: undefined,
    })
  })

  it('runShell 抛错 → {ok:false, error}', async () => {
    const runShell = vi.fn(async (_input: ShellCommandInput): Promise<ShellCommandResult> => {
      throw new Error('boom')
    })
    const ctx = makeCtx(runShell)

    const result = await shellLinuxTool.execute({ command: 'pwd' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'boom',
      code: 'SHELL_EXECUTION_ERROR',
      retryable: true,
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(shellLinuxTool.name).toBe('shell_linux')
    expect(shellLinuxTool.runtime).toBe('server') // 依赖 Tauri 本机 shell（TP3）。
    expect(shellLinuxTool.inputSchema).toMatchObject({ required: ['command'] })
    expect(shellLinuxTool.skill.content.length).toBeGreaterThan(0)
  })
})
