// 占位工具调用在 batch 这一层的准入（D3a）：同一个 mcp__* 名字，是暂停还是直接执行，
// 完全取决于「这次调用会不会先在本机起一个没人看过的进程」。
//
// 这一组守的是【接线】：分级矩阵在 dangerousTools.mcpToolCall.test.ts 里已单测过，这里跑真的
// runToolCallBatch，确认 core.config.mcpToolLaunchTarget 真的被喂进了 classifyToolRisk。
// 谁把那个字段从 toolCallBatch 的风险上下文里拿掉，第一条就会从 paused 变成 continue——
// 一条从没被人看过的命令行就会在 Auto 模式下无声跑起来。

import { describe, expect, it } from 'vitest'
import type { McpToolLaunchTargetProbe } from './dangerousTools'
import { runCall } from './toolCallBatch.authorization.testFixtures'

const UNSEEN_COMMAND = 'npx -y @imported/from-untrusted-json'
const UNSEEN_TOOL = 'mcp__imported__run'
const CONNECTED_TOOL = 'mcp__github__create_issue'

const mcpToolLaunchTarget: McpToolLaunchTargetProbe = (toolName) => {
  if (toolName === UNSEEN_TOOL) {
    return { spawnsLocalProcess: true, command: UNSEEN_COMMAND, launchConsented: false }
  }
  // 已连接的服务：这次调用打在真实工具上，不会拉起任何进程。
  return undefined
}

describe('mcp__* 调用的起进程准入', () => {
  it('未确认的 stdio 占位调用在 Auto 模式下也暂停，并摆出将要执行的命令', async () => {
    const { result, execute, run } = await runCall(
      UNSEEN_TOOL,
      'auto',
      { query: 'x' },
      { mcpToolLaunchTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: UNSEEN_TOOL, risk: 'dangerous' },
    })
    expect(run?.pendingToolConfirmation?.reason).toContain(UNSEEN_COMMAND)
  })

  /**
   * 会话级「一律允许」对 mcp__* 本来就不成立，这里再钉一次：即便有人越权把这个名字写进了
   * 记忆，未确认的起进程仍然要停。
   */
  it('会话记忆放行不了未确认的起进程', async () => {
    const { result, execute } = await runCall(
      UNSEEN_TOOL,
      'auto',
      {},
      { mcpToolLaunchTarget },
      [UNSEEN_TOOL],
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
  })

  it('已连接服务的普通调用在 Auto 模式下照旧直接执行（零回归）', async () => {
    const { result, execute, run } = await runCall(
      CONNECTED_TOOL,
      'auto',
      { title: 'test' },
      { mcpToolLaunchTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it('宿主没接这根线时行为与今天完全一致：Auto 直接执行', async () => {
    const { result, execute } = await runCall(UNSEEN_TOOL, 'auto', {})

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('确认模式下 mcp__* 照旧逐次确认', async () => {
    const { result, execute } = await runCall(
      CONNECTED_TOOL,
      'confirm',
      { title: 'test' },
      { mcpToolLaunchTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
  })
})
