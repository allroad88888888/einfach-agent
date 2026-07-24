import { describe, it, expect, vi } from 'vitest'
import type { ShellCommandInput, ShellCommandResult, ToolContext } from '@web-agent/core/tools/types'
import { shellPowershellTool } from './shell-powershell'

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

describe('shell_powershell tool', () => {
  it('合法参数 → ctx.runShell 被调用，返回 {ok:true, data}', async () => {
    const shellResult = makeShellResult(
      { platform: 'windows', command: 'Get-Location', cwd: 'C:\\Temp' },
      { stdout: 'ok' },
    )
    const runShell = vi.fn(async () => shellResult)
    const ctx = makeCtx(runShell)

    const result = await shellPowershellTool.execute(
      {
        command: '  Get-Location  ',
        cwd: '  C:\\Temp  ',
        timeoutMs: 1000,
        maxOutputChars: 5000,
        env: { A: '1', B: 2, EMPTY: '' },
      },
      ctx,
    )

    expect(runShell).toHaveBeenCalledWith({
      platform: 'windows',
      command: 'Get-Location',
      cwd: 'C:\\Temp',
      timeoutMs: 1000,
      maxOutputChars: 5000,
      env: { A: '1', EMPTY: '' },
    })
    expect(result).toEqual({ ok: true, data: shellResult })
  })

  it('非法 command → {ok:false}，且不调 runShell', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellPowershellTool.execute({ command: '   ' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid shell_powershell: command (non-empty string) is required',
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('文件写命令被拒绝并引导使用 write_file', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellPowershellTool.execute(
      { command: "Set-Content -Path src/a.ts -Value 'next'" },
      ctx,
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'shell_file_write_rejected',
      hint: expect.stringContaining('write_file'),
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it.each([
    "Set-Content -Path Env:WEB_AGENT_TEST -Value 'next'",
    "Write-Output 'next' | Out-File -FilePath NUL",
    "Write-Output 'next' > $null",
  ])('非文件 Provider 和空设备输出仍允许执行：%s', async (command) => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellPowershellTool.execute({ command }, ctx)

    expect(runShell).toHaveBeenCalledOnce()
  })

  it('Out-File 明确写入普通文件时拒绝', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellPowershellTool.execute(
      { command: "Write-Output 'next' | Out-File -FilePath src/a.ts" },
      ctx,
    )

    expect(result).toMatchObject({ ok: false, code: 'shell_file_write_rejected' })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('timeoutMs/maxOutputChars 使用默认值并执行上限 clamp', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellPowershellTool.execute({ command: 'Get-Location' }, ctx)
    await shellPowershellTool.execute(
      { command: 'Get-Location', timeoutMs: 999_999, maxOutputChars: 999_999 },
      ctx,
    )

    expect(runShell).toHaveBeenNthCalledWith(1, {
      platform: 'windows',
      command: 'Get-Location',
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputChars: 20_000,
      env: undefined,
    })
    expect(runShell).toHaveBeenNthCalledWith(2, {
      platform: 'windows',
      command: 'Get-Location',
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

    const result = await shellPowershellTool.execute({ command: 'Get-Location' }, ctx)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(shellPowershellTool.name).toBe('shell_powershell')
    expect(shellPowershellTool.runtime).toBe('server') // 依赖 Tauri 本机 shell（TP3）。
    expect(shellPowershellTool.inputSchema).toMatchObject({ required: ['command'] })
    expect(shellPowershellTool.skill.content.length).toBeGreaterThan(0)
  })
})
