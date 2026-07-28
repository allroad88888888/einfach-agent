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
})
