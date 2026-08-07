import { describe, it, expect } from 'vitest'
import type { ShellCommandResult } from '@web-agent/core/tools/types'
import { shellCommandToolResult } from './command-result'

function makeResult(overrides: Partial<ShellCommandResult> = {}): ShellCommandResult {
  return {
    platform: 'macos',
    shell: 'test',
    command: 'echo hi',
    cwd: '/tmp',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  }
}

describe('shellCommandToolResult', () => {
  it('backgroundProcessesKilled → 成功结果附带 warning，让模型知道后台服务没活下来', () => {
    const result = shellCommandToolResult(
      makeResult({ stdout: 'started', backgroundProcessesKilled: true }),
    )

    expect(result).toMatchObject({ ok: true })
    const warnings = 'ok' in result && result.ok ? (result.warnings ?? []) : []
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('后台进程')
  })

  it('未杀后台进程的普通成功结果不带 warnings', () => {
    const result = shellCommandToolResult(makeResult({ stdout: 'hi' }))

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ stdout: 'hi' }) })
    expect('ok' in result && result.ok ? result.warnings : undefined).toBeUndefined()
  })

  it('失败结果把同一提示并入 hint，且不覆盖原有 hint', () => {
    const notFound = shellCommandToolResult(
      makeResult({ exitCode: 127, backgroundProcessesKilled: true }),
    )
    const failed = shellCommandToolResult(
      makeResult({ exitCode: 1, backgroundProcessesKilled: true }),
    )

    expect(notFound).toMatchObject({ ok: false, code: 'SHELL_COMMAND_NOT_FOUND' })
    expect('ok' in notFound && !notFound.ok ? notFound.hint : '').toMatch(/PATH[\s\S]*后台进程/)
    expect('ok' in failed && !failed.ok ? failed.hint : '').toContain('后台进程')
  })

  it('超时结果同样带上提示，仍保持 SHELL_TIMEOUT 语义', () => {
    const result = shellCommandToolResult(
      makeResult({ timedOut: true, durationMs: 30_000, backgroundProcessesKilled: true }),
    )

    expect(result).toMatchObject({ ok: false, code: 'SHELL_TIMEOUT', retryable: true })
    expect('ok' in result && !result.ok ? result.hint : '').toContain('后台进程')
  })

  it('非零退出把 stderr 摘要放进 hint，避免模型只看到退出码', () => {
    const result = shellCommandToolResult(
      makeResult({ exitCode: 101, stderr: 'error[E0559]: Event::UserInput has no field named images' }),
    )

    expect(result).toMatchObject({ ok: false, code: 'SHELL_EXIT_NONZERO' })
    expect('ok' in result && !result.ok ? result.hint : '').toContain('error[E0559]')
  })

  it('grep 的 exit 1 提醒无匹配语义并引导使用专用搜索工具', () => {
    const result = shellCommandToolResult(
      makeResult({
        command: 'grep -n "vision" crates/agent-runtime/src/ctx.rs',
        exitCode: 1,
      }),
    )

    expect(result).toMatchObject({ ok: false, code: 'SHELL_EXIT_NONZERO' })
    const hint = 'ok' in result && !result.ok ? result.hint : ''
    expect(hint).toContain('无匹配')
    expect(hint).toContain('rg_search')
  })

  it('不含搜索命令的 exit 1 不猜测失败原因', () => {
    const result = shellCommandToolResult(makeResult({ command: 'false', exitCode: 1 }))

    expect('ok' in result && !result.ok ? result.hint : '').not.toContain('rg_search')
  })
})
