import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyMcpFailure, readMcpFailureKind } from '@einfach-agent/tools-mcp'
import { invokeServerCommand } from '../host/serverInvoke'
import {
  commandInputs,
  createConnectorUnderTest,
  serverInvokeFailure,
  serverInvokeOpaqueFailure,
  stdioConfig,
} from './serverStdioConnector.testHarness'

// 只替 `invokeServerCommand`：`ServerInvokeError` 要保留真身，失败翻译判的正是它的
// `instanceof` 与 `.status`。
vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const invokeMock = vi.mocked(invokeServerCommand)

function inputs(command: string): Array<Record<string, unknown>> {
  return commandInputs(invokeMock.mock.calls as unknown[][], command)
}

function mockSuccessfulConnect(): void {
  invokeMock.mockImplementationOnce((_command, args) => {
    const input = (args as { input: { serverId: string, sessionToken: string } }).input
    return Promise.resolve({
      serverId: input.serverId,
      sessionToken: input.sessionToken,
      pid: 123,
    })
  })
}

describe('ServerStdioMcpConnector：命令与结果', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('经 /api/invoke 连接、列工具、调用并幂等注销', async () => {
    mockSuccessfulConnect()
    invokeMock
      .mockResolvedValueOnce({
        tools: [{
          name: 'echo',
          description: '回显输入',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { echoed: true },
        isError: false,
        _meta: { traceId: 'trace-1' },
      })
      .mockResolvedValueOnce({ serverId: 'local', forcedKill: false })

    const { connector, sse } = createConnectorUnderTest()
    const connection = await connector.connect({
      id: 'local',
      name: '本地服务',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/workspace',
    })

    // `input` 那一层不许抹平：host-node 的四条 mcp handler 先剥它。
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'mcp_connect', {
      input: expect.objectContaining({
        serverId: 'local',
        sessionToken: expect.any(String),
        command: 'node',
        args: ['server.js'],
        cwd: '/workspace',
        requestTimeoutMs: 30_000,
        clientInfo: { name: 'einfach-agent', version: '0.1.0', title: 'Einfach Agent' },
      }),
    })
    const sessionToken = inputs('mcp_connect')[0]?.sessionToken

    await expect(connection.listTools()).resolves.toEqual([
      expect.objectContaining({ name: 'echo', description: '回显输入' }),
    ])
    await expect(connection.callTool('echo', { text: 'hello' })).resolves.toEqual({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { echoed: true },
      isError: false,
      _meta: { traceId: 'trace-1' },
    })

    await connection.close()
    await connection.close()
    expect(invokeMock.mock.calls.filter(([name]) => name === 'mcp_disconnect')).toHaveLength(1)
    // 刚建好的会话不该被重连补偿再列一次工具——列表调用有且只有用例自己发的那一次。
    expect(invokeMock.mock.calls.filter(([name]) => name === 'mcp_list_tools')).toHaveLength(1)
    expect(inputs('mcp_list_tools')[0]?.sessionToken).toBe(sessionToken)
    expect(inputs('mcp_call_tool')[0]?.sessionToken).toBe(sessionToken)
    expect(inputs('mcp_disconnect')[0]?.sessionToken).toBe(sessionToken)
    // 最后一条会话注销 → 共享事件流也收掉。
    expect(sse.calls[0]?.signal.aborted).toBe(true)
  })

  it('拒绝把 HTTP 配置交给 stdio connector', async () => {
    const { connector } = createConnectorUnderTest()
    await expect(connector.connect({
      id: 'remote',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
    })).rejects.toThrow('不支持传输')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('把传输关闭错误通知给连接管理器，且不暴露子进程 stderr', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce(
      serverInvokeFailure('transport_closed', 'MCP server transport is closed'),
    )

    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const onClose = vi.fn()
    connection.onClose(onClose)

    await expect(connection.callTool('echo', {})).rejects.toThrow('MCP server transport is closed')
    await expect(connection.callTool('echo', {})).rejects.not.toThrow('API_KEY')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('拒绝把被分页上限截断的工具列表当成完整快照', async () => {
    mockSuccessfulConnect()
    invokeMock.mockResolvedValueOnce({
      tools: [{ name: 'partial', inputSchema: { type: 'object' } }],
      truncated: true,
    })

    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())

    // 文案按本机后端措辞（历史上桌面版那条写的是「桌面端」）：上限本身同值。
    await expect(connection.listTools()).rejects.toThrow('超过本机服务分页上限')
  })

  it('严格拒绝缺失或非对象的 inputSchema', async () => {
    mockSuccessfulConnect()
    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())

    for (const inputSchema of [undefined, null, [], 'string']) {
      invokeMock.mockResolvedValueOnce({
        tools: [{
          name: 'invalid-schema',
          ...(inputSchema === undefined ? {} : { inputSchema }),
        }],
      })
      await expect(connection.listTools()).rejects.toThrow('inputSchema 必须是对象')
    }
  })

  it('注销已退出的会话仍视为成功', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce(
      serverInvokeFailure('not_connected', 'MCP server is not connected'),
    )

    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())

    await expect(connection.close()).resolves.toBeUndefined()
  })

  it('把结构化 kind 透传给失败分类，不依赖服务端文案', async () => {
    invokeMock.mockRejectedValueOnce(
      serverInvokeFailure('command_spawn_failed', '这段文案随时可能被改写，分类不许依赖它'),
    )

    const { connector } = createConnectorUnderTest()
    const failure = await connector.connect(stdioConfig()).catch((error: unknown) => error)

    expect(readMcpFailureKind(failure)).toBe('command_spawn_failed')
    expect(classifyMcpFailure(failure)).toMatchObject({
      status: 'error',
      reason: 'command_unavailable',
    })
  })

  it('传输类 kind 也透传出去，仍归类为可重试', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce(
      serverInvokeFailure('transport_closed', 'MCP server transport is closed'),
    )

    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const failure = await connection.listTools().catch((error: unknown) => error)

    expect(readMcpFailureKind(failure)).toBe('transport_closed')
    expect(classifyMcpFailure(failure)).toMatchObject({ status: 'reconnecting' })
  })

  /**
   * 今天服务端还没把 `McpCommandError` 映射成 502 + kind（见 `serverMcpCommands.ts` 文件头），
   * 一次 MCP 失败落地成一条不带信封的 500。这条用例钉住**降级是安全的**：
   *   · 拿不到 kind → 分类器退到「可重试」，不会把一次失败误判成永久失败；
   *   · **HTTP 状态绝不能漏给分类器**——`ServerInvokeError` 自带 `.status`，
   *     而 `classifyMcpFailure` 的 `readHttpStatus()` 会把错误对象上的 `status` 当成
   *     「MCP 传输观察到的 HTTP 状态」，401/403 直接判永久失败。
   */
  it('服务端还没映射 kind 时安全降级，且不把 HTTP 状态漏给分类器', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce(serverInvokeOpaqueFailure())

    const { connector } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const failure = await connection.listTools().catch((error: unknown) => error)

    expect(readMcpFailureKind(failure)).toBeUndefined()
    expect(failure).not.toHaveProperty('status')
    expect(classifyMcpFailure(failure)).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
  })

  it('连接返回了不匹配的会话标识时拒绝，并把那次连接清理掉', async () => {
    invokeMock.mockResolvedValueOnce({ serverId: 'local', sessionToken: 'someone-elses' })
    invokeMock.mockResolvedValueOnce({ serverId: 'local', forcedKill: false })

    const { connector } = createConnectorUnderTest()
    await expect(connector.connect(stdioConfig())).rejects.toThrow('不匹配的会话标识')
    expect(inputs('mcp_disconnect')).toHaveLength(1)
  })

  it('连接被取消后用旧 token 清理迟到进程，不影响同 ID 的新连接', async () => {
    let finishConnect!: (value: unknown) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { finishConnect = resolve }))

    const controller = new AbortController()
    const { connector } = createConnectorUnderTest()
    const pending = connector.connect(stdioConfig(), { signal: controller.signal })

    await vi.waitFor(() => { expect(inputs('mcp_connect')).toHaveLength(1) })
    const oldSessionToken = inputs('mcp_connect')[0]?.sessionToken
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    let finishStaleDisconnect!: (value: unknown) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishStaleDisconnect = resolve
    }))
    finishConnect({ serverId: 'local', sessionToken: oldSessionToken, pid: 123 })
    await vi.waitFor(() => { expect(inputs('mcp_disconnect')).toHaveLength(1) })
    expect(inputs('mcp_disconnect')[0]).toEqual({
      serverId: 'local',
      sessionToken: oldSessionToken,
      gracePeriodMs: 500,
    })

    mockSuccessfulConnect()
    const connection = await connector.connect(stdioConfig())
    const sessionToken = inputs('mcp_connect')[1]?.sessionToken
    expect(sessionToken).not.toBe(oldSessionToken)

    invokeMock.mockResolvedValueOnce({ tools: [] })
    await expect(connection.listTools()).resolves.toEqual([])
    expect(inputs('mcp_list_tools')[0]?.sessionToken).toBe(sessionToken)

    finishStaleDisconnect({ serverId: 'local', sessionToken: oldSessionToken, forcedKill: false })
    invokeMock.mockResolvedValueOnce({ serverId: 'local', sessionToken, forcedKill: false })
    await connection.close()
    expect(inputs('mcp_disconnect')[1]?.sessionToken).toBe(sessionToken)
  })
})
