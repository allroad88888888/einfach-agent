// connect_mcp_server 在 batch 这一层的准入：同一个工具名、同一份参数形状，是暂停还是直接
// 执行完全取决于 serverId 指向哪里、以及那条启动命令用户看没看过。
//
// 这一组守的是【接线】：核心策略在 dangerousTools.test.ts 里已单测过，这里跑真的
// runToolCallBatch，确认 core.config.mcpConnectTarget 确实被喂进了 classifyToolRisk，
// 且 needsConfirmation 真的照它的结论暂停。谁把那个字段从 toolCallBatch 的 context 里拿掉，
// HTTP 那条就会从 continue 变成 paused；谁把 requiresConfirmation 从 needsConfirmation 里
// 拿掉，Auto 模式那两条就会从 paused 变成 continue。

import { describe, expect, it } from 'vitest'
import { MCP_CONNECT_TOOL_NAME, type McpConnectTargetProbe } from './dangerousTools'
import { runCall } from './toolCallBatch.authorization.testFixtures'

describe('connect_mcp_server authorization by transport', () => {
  const STDIO_COMMAND = 'node /Users/me/tools/server.js --stdio'
  const UNSEEN_COMMAND = 'npx -y @imported/from-untrusted-json'
  const mcpConnectTarget: McpConnectTargetProbe = serverId => {
    // local-tools：用户确认过这条启动命令（宿主的 launchConsent 指纹对得上）。
    if (serverId === 'local-tools') {
      return { spawnsLocalProcess: true, command: STDIO_COMMAND, launchConsented: true }
    }
    // unseen-tools：配置存在，但那条命令从没被人看过（例如导入一份 JSON 就直接躺在配置里）。
    if (serverId === 'unseen-tools') {
      return { spawnsLocalProcess: true, command: UNSEEN_COMMAND, launchConsented: false }
    }
    if (serverId === 'remote-tools') return { spawnsLocalProcess: false }
    return undefined
  }

  it('pauses a stdio server connect and shows the command that will run', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: MCP_CONNECT_TOOL_NAME },
    })
    expect(run?.pendingToolConfirmation?.reason).toContain(STDIO_COMMAND)
  })

  it('executes an HTTP server connect without a confirmation card', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'remote-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it('pauses when the host never wired a transport probe', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run?.status).toBe('waiting_confirmation')
  })

  it('pauses when the probe does not know the server id', async () => {
    const { result, execute } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'never-configured' },
      { mcpConnectTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
  })

  // F7：连接工具永远拿不到 session 级「一律允许」，所以【每一次】连接都要单独确认。
  // 记忆是按工具名的：如果它能被记住，用户对某一个服务的一次同意，就成了本会话内连接任意
  // 已配置服务（包括在本机起进程的 stdio 服务）的通行证。
  it('pauses every stdio connect even when the session already remembers the connect tool', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
      [MCP_CONNECT_TOOL_NAME],
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: MCP_CONNECT_TOOL_NAME },
    })
  })

  // Auto 模式下【已确认过】的 stdio 连接直接执行：与 shell_* 同级 —— 那条命令用户亲眼看过，
  // 剩下的只是「要不要每次都再问一遍」，而这正是 Auto 模式在回答的问题。
  it('executes a consented stdio server connect directly in auto mode', async () => {
    const { result, execute } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'auto',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })

  /**
   * F8 的判据，断言在 batch 这一层：从没被确认过的启动命令，Auto 模式也必须停下来。
   *
   * 反例正是这道门存在的全部意义：用户从不可信来源导入一份 JSON（从没点开过确认弹窗）、
   * 开着 Auto，模型调一次 connect_mcp_server —— 一条没有任何人看过的命令就在本机跑了。
   * needsConfirmation 里 `risk.requiresConfirmation ||` 那一项被删掉，这条就会红。
   */
  it('pauses an unconsented stdio server connect even in auto mode', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'auto',
      { serverId: 'unseen-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: MCP_CONNECT_TOOL_NAME, risk: 'dangerous' },
    })
    // 确认卡片必须摆出那条命令，否则用户批准的是一个自己看不见的东西。
    expect(run?.pendingToolConfirmation?.reason).toContain(UNSEEN_COMMAND)
  })

  it('pauses in auto mode when the host never wired a transport probe', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'auto',
      { serverId: 'local-tools' },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run?.status).toBe('waiting_confirmation')
  })

  it('still executes an HTTP server connect in auto mode', async () => {
    const { result, execute } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'auto',
      { serverId: 'remote-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })
})
