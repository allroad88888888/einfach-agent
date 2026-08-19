import { afterEach, describe, it, expect, vi } from 'vitest'
import { configureHostInvoke } from '@einfach-agent/core'
import type { ShellCommandInput, ShellCommandResult, ToolContext } from '@einfach-agent/core/tools'
import { runVerificationCommandTool } from './run-verification-command'

/**
 * 登记一座声明了 `platform` 的假宿主桥。本工具是 S5 说的**消费者①**：命令参数里没有平台信息，
 * 它得自己说出目标平台，而宿主收到后会拒绝与自己不符的值。桥背后调不调得通与这里无关
 * （ctx.runShell 由用例自己桩），要的只是「宿主声明了什么平台」这半边。
 */
function registerHostPlatform(platform: 'macos' | 'linux' | 'windows' | 'unsupported'): void {
  configureHostInvoke({
    loader: () => Promise.resolve((async () => undefined) as never),
    platform,
  })
}

afterEach(() => {
  configureHostInvoke(undefined)
})

function makeShellResult(
  input: ShellCommandInput,
  overrides: Partial<ShellCommandResult> = {},
): ShellCommandResult {
  return {
    platform: input.platform,
    shell: 'test',
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

function makeCtx(options: { runShell?: ToolContext['runShell'] } = {}) {
  const runShell = options.runShell ?? vi.fn(async (input: ShellCommandInput) => makeShellResult(input))
  return {
    ctx: {
      sessionId: 's',
      signal: new AbortController().signal,
      progress: vi.fn(),
      callTool: vi.fn(),
      renderCard: vi.fn(),
      saveArtifact: vi.fn(),
      runShell,
    } as unknown as ToolContext,
    runShell,
  }
}

describe('run_verification_command tool', () => {
  it('可执行任意验收 shell 命令，包括项目脚本', async () => {
    const { ctx, runShell } = makeCtx()

    const result = await runVerificationCommandTool.execute({ command: '  bash scripts/verify.sh  ' }, ctx)

    expect(runShell).toHaveBeenCalledOnce()
    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({
      command: 'bash scripts/verify.sh',
      timeoutMs: 600_000,
      maxOutputChars: 100_000,
    }))
    expect(result).toMatchObject({ ok: true, data: { command: 'bash scripts/verify.sh', exitCode: 0 } })
  })

  it('空 command → 参数错误且不执行', async () => {
    const { ctx, runShell } = makeCtx()

    const result = await runVerificationCommandTool.execute({ command: '   ' }, ctx)

    expect(runShell).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      error: 'invalid run_verification_command: command (non-empty string) is required',
      code: 'VERIFICATION_INVALID_INPUT',
      retryable: false,
    })
  })

  it('web 环境（shell 桥不可用）→ ok:false shell unavailable，不抛', async () => {
    const runShell = vi.fn(async (input: ShellCommandInput) => makeShellResult(input, {
      shell: 'unavailable',
      exitCode: 1,
      stderr: 'Shell command execution is only available in the Tauri desktop runtime',
    }))
    const { ctx } = makeCtx({ runShell })

    const result = await runVerificationCommandTool.execute({ command: 'pnpm test' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      error: 'run_verification_command unavailable: shell unavailable in this runtime',
      code: 'VERIFICATION_SHELL_UNAVAILABLE',
      retryable: false,
    })
  })

  it('ctx 完全没有 runShell 能力 → ok:false shell unavailable，不抛', async () => {
    const { ctx } = makeCtx()
    const contextWithoutShell = { ...(ctx as unknown as Record<string, unknown>) }
    delete contextWithoutShell.runShell

    const result = await runVerificationCommandTool.execute(
      { command: 'pnpm test' },
      contextWithoutShell as unknown as ToolContext,
    )

    expect(result).toMatchObject({
      ok: false,
      error: 'run_verification_command unavailable: shell unavailable in this runtime',
      code: 'VERIFICATION_SHELL_UNAVAILABLE',
    })
  })

  it('命令非零退出仍是有效证据：ok:false + 完整 details', async () => {
    const failing = makeShellResult(
      { platform: 'macos', command: 'pnpm test' },
      { exitCode: 1, stdout: '6 failed', stderr: 'FAIL' },
    )
    const { ctx } = makeCtx({ runShell: vi.fn(async () => failing) })

    const result = await runVerificationCommandTool.execute({ command: 'pnpm test' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      code: 'SHELL_EXIT_NONZERO',
      details: failing,
    })
  })

  it('runShell 抛错 → 包成 ok:false，不向调用方抛', async () => {
    const runShell = vi.fn(async (_input: ShellCommandInput): Promise<ShellCommandResult> => {
      throw new Error('boom')
    })
    const { ctx } = makeCtx({ runShell })

    const result = await runVerificationCommandTool.execute({ command: 'pnpm test' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'boom',
      code: 'VERIFICATION_EXECUTION_ERROR',
      retryable: true,
    })
  })

  it('平台取自宿主声明，不是本地探测（S5）', async () => {
    // 场景：用户在 macOS 的浏览器里，服务端是 Linux。本地探测会答 macos，于是每条命令都撞
    // `platform mismatch: requested \`macos\`, current \`linux\``——server 宿主下 shell 整个不可用。
    // 这里断言桥收到的是**宿主声明的 linux**，与注入给模型的「运行环境」段读的是同一个函数。
    registerHostPlatform('linux')
    const { ctx, runShell } = makeCtx()

    await runVerificationCommandTool.execute({ command: 'pnpm test' }, ctx)

    expect(runShell).toHaveBeenCalledWith(expect.objectContaining({ platform: 'linux' }))
  })

  it('宿主平台不支持 shell 时根本不发命令，回既有的 shell unavailable 口径', async () => {
    registerHostPlatform('unsupported')
    const { ctx, runShell } = makeCtx()

    const result = await runVerificationCommandTool.execute({ command: 'pnpm test' }, ctx)

    expect(runShell).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      error: 'run_verification_command unavailable: shell unavailable in this runtime',
      code: 'VERIFICATION_SHELL_UNAVAILABLE',
    })
  })

  it('身份/runtime/schema/skill 元数据齐备', () => {
    expect(runVerificationCommandTool.name).toBe('run_verification_command')
    expect(runVerificationCommandTool.runtime).toBe('server')
    expect(runVerificationCommandTool.inputSchema).toMatchObject({
      required: ['command'],
      additionalProperties: false,
    })
    expect(Object.keys((runVerificationCommandTool.inputSchema as { properties: object }).properties))
      .toEqual(['command'])
    expect(runVerificationCommandTool.skill.content.length).toBeGreaterThan(0)
  })
})
