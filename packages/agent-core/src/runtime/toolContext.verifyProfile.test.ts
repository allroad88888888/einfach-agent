// toolContext workspace_verify 档位的宿主侧闸门测试。
// ---------------------------------------------------------------------------
// run_verification_command 仅经子 agent 工具桥暴露；主循环没有 workspace_verify 档位。
// 拆分自 toolContext.workspaceRoot.test.ts（A2b），与 toolContext.workspaceRoot.test.ts
// 同属一套 workspaceRoot/子 agent 桥测试，只是各自绑定不同 describe；两份共享的
// seedSession / runDelegation / delegateRuntimeCapturing helper 住 toolContext.workspaceRoot.testHarness.ts。
// 只 mock './shellCommand'：本文件全部断言都落在 ctx.runShell → runShellCommand 这一条链上，
// 不涉及 workspaceRead/Write 等其余桥，无需像 workspaceRoot 那份逐个 mock。

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./shellCommand', () => ({
  runShellCommand: vi.fn(async (input: { platform: string; command: string; cwd?: string }) => ({
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
  })),
}))

import { buildToolContext } from './toolContext'
import { runShellCommand } from './shellCommand'
import { defaultCore } from './core/coreInstance'
import { delegateRuntimeCapturing, seedSession, runDelegation } from './toolContext.workspaceRoot.testHarness'

afterEach(() => {
  vi.clearAllMocks()
})

describe('toolContext 验证命令执行（workspace_verify）', () => {
  it('workspace_verify 子 agent 可执行验收所需的 shell 命令', async () => {
    seedSession('verify-allowed', '/ws/root')
    let allowed: unknown
    let additionalCommand: unknown
    const ctx = buildToolContext({
      sessionId: 'verify-allowed',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'submit_stage_result',
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        allowed = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test' })
        additionalCommand = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test --bail' })
      }, 'verify-allowed'),
    })

    await runDelegation(ctx, {
      children: [{ objective: 'verify' }],
      toolProfile: 'workspace_verify',
    })

    expect(allowed).toMatchObject({ ok: true })
    expect(additionalCommand).toMatchObject({ ok: true })
    expect(vi.mocked(runShellCommand)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({
      command: 'pnpm test',
      cwd: '/ws/root',
    })
  })

  it('workspace_read 子 agent 无法使用验证工具', async () => {
    seedSession('verify-missing', '/ws/root')
    let result: unknown
    const ctx = buildToolContext({
      sessionId: 'verify-missing',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'delegate_agent',
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        result = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test' })
      }, 'verify-missing'),
    })

    await runDelegation(ctx, {
      children: [{ objective: 'read' }],
      toolProfile: 'workspace_read',
    })

    expect(result).toEqual({ ok: false, error: 'tool not allowed for child agent: run_verification_command' })
    expect(vi.mocked(runShellCommand)).not.toHaveBeenCalled()
  })

  it('直接执行验证工具时不受命令白名单限制', async () => {
    seedSession('verify-main-agent', '/ws/root')
    const ctx = buildToolContext({
      sessionId: 'verify-main-agent',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'run_verification_command',
    })

    const result = await defaultCore.tools.run('run_verification_command', { command: 'pnpm test' }, ctx)

    expect(result).toMatchObject({ ok: true })
    expect(vi.mocked(runShellCommand)).toHaveBeenCalledOnce()
  })
})
