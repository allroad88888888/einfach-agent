import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeServerCommand } from '../host/serverInvoke'
import { sseFrame } from './serverHostEventStream.testHarness'
import {
  commandInputs,
  createConnectorUnderTest,
  serverInvokeFailure,
  stdioConfig,
} from './serverStdioConnector.testHarness'

vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const invokeMock = vi.mocked(invokeServerCommand)

function inputs(command: string): Array<Record<string, unknown>> {
  return commandInputs(invokeMock.mock.calls as unknown[][], command)
}

function listToolsCalls(): number {
  return invokeMock.mock.calls.filter(([name]) => name === 'mcp_list_tools').length
}

function mockSuccessfulConnect(): void {
  invokeMock.mockImplementationOnce((_command, args) => {
    const input = (args as { input: { serverId: string, sessionToken: string } }).input
    return Promise.resolve({ serverId: input.serverId, sessionToken: input.sessionToken })
  })
}

describe('ServerStdioMcpConnector：SSE 生命周期事件', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('只把匹配 (serverId, sessionToken) 的事件交给对应会话', async () => {
    mockSuccessfulConnect()
    const { connector, sse } = createConnectorUnderTest()
    const oldConnection = await connector.connect(stdioConfig())
    const oldSessionToken = inputs('mcp_connect')[0]?.sessionToken as string
    invokeMock.mockResolvedValueOnce({ serverId: 'local', forcedKill: false })
    await oldConnection.close()

    mockSuccessfulConnect()
    const connection = await connector.connect(stdioConfig())
    const sessionToken = inputs('mcp_connect')[1]?.sessionToken as string
    expect(sessionToken).not.toBe(oldSessionToken)

    const onToolsChanged = vi.fn()
    const onClose = vi.fn()
    connection.onToolsChanged(onToolsChanged)
    connection.onClose(onClose)

    await vi.waitFor(() => { expect(sse.connections.length).toBeGreaterThanOrEqual(1) })
    const live = sse.connections.at(-1)!
    // 旧会话的两条 + 别的 server 的一条：一条都不该落到当前连接上。
    live.push(sseFrame('mcp-stdio-tools-changed', { serverId: 'local', sessionToken: oldSessionToken }))
    live.push(sseFrame('mcp-stdio-close', {
      serverId: 'local',
      sessionToken: oldSessionToken,
      message: 'old session stopped',
    }))
    live.push(sseFrame('mcp-stdio-close', {
      serverId: 'another-server',
      sessionToken,
      message: 'another server stopped',
    }))
    live.push(sseFrame('mcp-stdio-tools-changed', { serverId: 'local', sessionToken }))
    await vi.waitFor(() => { expect(onToolsChanged).toHaveBeenCalledOnce() })
    expect(onClose).not.toHaveBeenCalled()

    live.push(sseFrame('mcp-stdio-close', {
      serverId: 'local',
      sessionToken,
      message: 'current session stopped',
    }))
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(onClose.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'current session stopped' }),
    )
    await expect(connection.listTools()).rejects.toThrow('current session stopped')
    // 会话没了 → 事件路由也摘干净 → 共享连接随之收掉。
    expect(sse.calls.at(-1)?.signal.aborted).toBe(true)
  })

  it('close 事件缺 message 时用兜底文案（消费方防御，不是契约变松）', async () => {
    mockSuccessfulConnect()
    const { connector, sse } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const sessionToken = inputs('mcp_connect')[0]?.sessionToken as string
    const onClose = vi.fn()
    connection.onClose(onClose)

    await vi.waitFor(() => { expect(sse.connections).toHaveLength(1) })
    sse.connections[0]!.push(sseFrame('mcp-stdio-close', { serverId: 'local', sessionToken }))
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(onClose.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'MCP server transport closed unexpectedly: local' }),
    )
    // 意外关闭同样要把自己从事件路由上摘掉；这是最后一条会话，共享连接随之收掉。
    // 漏掉这一步的症状离病因极远：一条没有消费方的 SSE 会永远挂着并不断重连。
    expect(sse.calls.at(-1)?.signal.aborted).toBe(true)
  })

  it('连接失败时把自己从事件路由上摘掉', async () => {
    invokeMock.mockRejectedValueOnce(serverInvokeFailure('command_spawn_failed', 'spawn failed'))

    const { connector, sse } = createConnectorUnderTest()
    await expect(connector.connect(stdioConfig())).rejects.toThrow('spawn failed')

    await vi.waitFor(() => { expect(sse.calls).toHaveLength(1) })
    expect(sse.calls[0]?.signal.aborted).toBe(true)
  })
})

describe('ServerStdioMcpConnector：事件流重连补偿', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('每次重新连上事件流都重拉一次工具清单，并报一次 toolsChanged', async () => {
    mockSuccessfulConnect()
    const { connector, sse } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const sessionToken = inputs('mcp_connect')[0]?.sessionToken
    const onToolsChanged = vi.fn()
    connection.onToolsChanged(onToolsChanged)

    await vi.waitFor(() => { expect(sse.connections).toHaveLength(1) })
    expect(listToolsCalls()).toBe(0)

    // 服务端重启：流结束 → 重连 → 补偿。
    invokeMock.mockResolvedValueOnce({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })
    sse.connections[0]!.end()

    await vi.waitFor(() => { expect(onToolsChanged).toHaveBeenCalledOnce() })
    expect(listToolsCalls()).toBe(1)
    expect(inputs('mcp_list_tools')[0]).toEqual({
      serverId: 'local',
      sessionToken,
      allPages: true,
      timeoutMs: 30_000,
    })
  })

  it('重连后拉不到工具清单的会话按已关闭处理', async () => {
    mockSuccessfulConnect()
    const { connector, sse } = createConnectorUnderTest()
    const connection = await connector.connect(stdioConfig())
    const onClose = vi.fn()
    const onToolsChanged = vi.fn()
    connection.onClose(onClose)
    connection.onToolsChanged(onToolsChanged)

    await vi.waitFor(() => { expect(sse.connections).toHaveLength(1) })
    invokeMock.mockRejectedValueOnce(
      serverInvokeFailure('stale_session', 'MCP session token is stale'),
    )
    sse.connections[0]!.end()

    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(onToolsChanged).not.toHaveBeenCalled()
    await expect(connection.listTools()).rejects.toThrow('MCP session token is stale')
    expect(sse.calls.at(-1)?.signal.aborted).toBe(true)
  })

  it('还在建立中的会话不参与补偿（它自己的 connect 回执才是真相）', async () => {
    let finishConnect!: (value: unknown) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { finishConnect = resolve }))

    const { connector, sse } = createConnectorUnderTest()
    const pending = connector.connect(stdioConfig())
    await vi.waitFor(() => { expect(sse.connections).toHaveLength(1) })

    sse.connections[0]!.end()
    await vi.waitFor(() => { expect(sse.connections).toHaveLength(2) })
    expect(listToolsCalls()).toBe(0)

    const sessionToken = inputs('mcp_connect')[0]?.sessionToken
    finishConnect({ serverId: 'local', sessionToken })
    const connection = await pending
    invokeMock.mockResolvedValueOnce({ serverId: 'local', forcedKill: false })
    await connection.close()
  })

  it('已注销的会话不再被补偿，也不再收到事件', async () => {
    mockSuccessfulConnect()
    const { connector, sse } = createConnectorUnderTest()
    const first = await connector.connect(stdioConfig('a'))
    mockSuccessfulConnect()
    const second = await connector.connect(stdioConfig('b'))
    const secondToken = inputs('mcp_connect')[1]?.sessionToken

    invokeMock.mockResolvedValueOnce({ serverId: 'a', forcedKill: false })
    await first.close()

    await vi.waitFor(() => { expect(sse.connections).toHaveLength(1) })
    invokeMock.mockResolvedValueOnce({ tools: [] })
    sse.connections[0]!.end()

    await vi.waitFor(() => { expect(listToolsCalls()).toBe(1) })
    // 只补偿了还活着的那条。
    expect(inputs('mcp_list_tools')[0]?.sessionToken).toBe(secondToken)

    invokeMock.mockResolvedValueOnce({ serverId: 'b', forcedKill: false })
    await second.close()
  })
})
