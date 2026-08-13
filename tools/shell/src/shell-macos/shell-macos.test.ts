import { describe, it, expect, vi } from 'vitest'
import type { ShellCommandInput, ShellCommandResult, ToolContext } from '@web-agent/core/tools'
import { shellMacosTool } from './shell-macos'

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

describe('shell_macos tool', () => {
  it('合法参数 → ctx.runShell 被调用，返回 {ok:true, data}', async () => {
    const shellResult = makeShellResult(
      { platform: 'macos', command: 'pwd', cwd: '/tmp' },
      { stdout: 'ok' },
    )
    const runShell = vi.fn(async () => shellResult)
    const ctx = makeCtx(runShell)

    const result = await shellMacosTool.execute(
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
      platform: 'macos',
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

    const result = await shellMacosTool.execute({ command: '   ' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'invalid shell_macos: command (non-empty string) is required',
      code: 'SHELL_INVALID_INPUT',
      retryable: false,
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it.each([
    ["sed -i '' 's/old/new/g' src/a.ts", 'sed in-place edit'],
    [
      `python3 -c "with open('src/a.rs', 'w') as f: f.write('next')"`,
      'Python script writes files',
    ],
    ["python3 <<'PY'\nfrom pathlib import Path\nPath('a').write_text('next')\nPY", 'scripted filesystem write'],
    ["printf 'next' > src/a.ts", 'shell output redirection writes a file'],
  ])('文件写命令被拒绝并引导使用 write_file：%s', async (command, reason) => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    const result = await shellMacosTool.execute({ command }, ctx)

    expect(result).toEqual({
      ok: false,
      code: 'shell_file_write_rejected',
      error: `shell_macos rejected: detected file modification via shell (${reason})`,
      hint: 'Use write_file for text file writes, or apply_patch for targeted edits to existing files. Shell commands must not write file contents directly.',
    })
    expect(runShell).not.toHaveBeenCalled()
  })

  it('只读 Python 和 stderr descriptor 重定向仍允许执行', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellMacosTool.execute(
      { command: `python3 -c "print(open('src/a.ts', 'r').read())" 2>&1` },
      ctx,
    )

    expect(runShell).toHaveBeenCalledOnce()
  })

  it.each([
    "printf 'next' > /dev/null",
    "printf 'next' > /dev/stdout",
    "printf 'next' | tee",
    "printf 'next' | tee /dev/stderr",
    'touch src/a.ts',
  ])('非普通文件内容写入仍允许执行：%s', async (command) => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellMacosTool.execute({ command }, ctx)

    expect(runShell).toHaveBeenCalledOnce()
  })

  it.each(["printf 'next' | tee src/a.ts", "printf 'next' >> src/a.ts"])(
    '明确写入普通文件内容时仍拒绝：%s',
    async (command) => {
      const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
      const ctx = makeCtx(runShell)

      const result = await shellMacosTool.execute({ command }, ctx)

      expect(result).toMatchObject({ ok: false, code: 'shell_file_write_rejected' })
      expect(runShell).not.toHaveBeenCalled()
    },
  )

  it.each([
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'git clean -fd',
    'git reset --hard HEAD',
  ])('Git 工作区操作仍允许执行：%s', async (command) => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellMacosTool.execute({ command }, ctx)

    expect(runShell).toHaveBeenCalledOnce()
  })

  it('timeoutMs/maxOutputChars 使用默认值并执行上限 clamp', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
    const ctx = makeCtx(runShell)

    await shellMacosTool.execute({ command: 'id' }, ctx)
    await shellMacosTool.execute(
      { command: 'id', timeoutMs: 999_999, maxOutputChars: 999_999 },
      ctx,
    )

    expect(runShell).toHaveBeenNthCalledWith(1, {
      platform: 'macos',
      command: 'id',
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputChars: 20_000,
      env: undefined,
    })
    expect(runShell).toHaveBeenNthCalledWith(2, {
      platform: 'macos',
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

    const result = await shellMacosTool.execute({ command: 'pwd' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'boom',
      code: 'SHELL_EXECUTION_ERROR',
      retryable: true,
    })
  })

  it('找不到命令时返回 shell/cwd 和可执行诊断建议', async () => {
    const shellResult = makeShellResult(
      { platform: 'macos', command: 'missing-command' },
      {
        shell: '/bin/zsh -lc',
        cwd: '/workspace',
        exitCode: 127,
        stderr: 'command not found',
      },
    )
    const result = await shellMacosTool.execute(
      { command: 'missing-command' },
      makeCtx(vi.fn(async () => shellResult)),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'SHELL_COMMAND_NOT_FOUND',
      retryable: false,
      details: shellResult,
    })
    if ('ok' in result && !result.ok) {
      expect(result.error).toContain('/bin/zsh -lc')
      expect(result.error).toContain('/workspace')
      expect(result.hint).toContain('command -v')
    }
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(shellMacosTool.name).toBe('shell_macos')
    expect(shellMacosTool.runtime).toBe('server') // 依赖 Tauri 本机 shell（TP3）。
    expect(shellMacosTool.inputSchema).toMatchObject({ required: ['command'] })
    expect(shellMacosTool.skill.content.length).toBeGreaterThan(0)
  })
})
