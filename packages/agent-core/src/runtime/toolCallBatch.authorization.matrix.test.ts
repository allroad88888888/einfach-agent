// 内建工具在 batch 这一层的准入矩阵：哪些名字 × 哪种授权模式 = 暂停还是直接执行。
// 连接工具（connect_mcp_server）的准入不按名字定，在 toolCallBatch.mcpConnect.test.ts。

import { describe, expect, it } from 'vitest'
import { runCall } from './toolCallBatch.authorization.testFixtures'

const shellTools = ['shell_macos', 'shell_linux', 'shell_powershell'] as const
const approvalModes = ['confirm', 'auto'] as const

describe('tool-call authorization matrix', () => {
  it.each(shellTools)('pauses %s in confirm mode', async name => {
    const { result, execute, run } = await runCall(name, 'confirm', { command: 'echo ok' })

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: name },
    })
  })

  it.each(shellTools)('pauses critical recursive deletion through %s in auto mode', async name => {
    const { result, execute, run } = await runCall(name, 'auto', { command: 'rm -rf /' })

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: name, risk: 'critical' },
    })
  })

  it('executes write_file directly in auto mode', async () => {
    const { result, execute, run } = await runCall('write_file', 'auto', {
      path: 'note.txt',
      content: 'hello',
    })

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it('executes MCP tools directly in auto mode', async () => {
    const { result, execute, run } = await runCall('mcp__github__create_issue', 'auto', {
      title: 'Created without a confirmation card',
    })

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it.each(approvalModes)('executes git_diff_review directly in %s mode', async approvalMode => {
    const { result, execute, run } = await runCall('git_diff_review', approvalMode, {})

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  // 对照组（配 toolCallBatch.mcpConnect.test.ts 里 F7 的「连接工具不可记忆」）：
  // 普通危险工具的 session 记忆仍然照常生效，别把闸门修成一刀切。
  it('still honors a remembered approval for an ordinary dangerous tool', async () => {
    const { result, execute } = await runCall(
      'write_file',
      'confirm',
      { path: 'note.txt', content: 'hello' },
      undefined,
      ['write_file'],
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })
})
