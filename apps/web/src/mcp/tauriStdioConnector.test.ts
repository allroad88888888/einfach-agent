import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createTauriStdioMcpConnector } from './tauriStdioConnector'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)
type TestEventHandler = (event: {
  event: string
  id: number
  payload: unknown
}) => void
const eventHandlers = new Map<string, Set<TestEventHandler>>()
const unlistenMocks: Array<ReturnType<typeof vi.fn>> = []

function mockSuccessfulConnect(): void {
  invokeMock.mockImplementationOnce((_command, args) => {
    const input = (args as {
      input: { serverId: string; sessionToken: string }
    }).input
    return Promise.resolve({
      serverId: input.serverId,
      sessionToken: input.sessionToken,
      pid: 123,
    })
  })
}

function commandInputs(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls.flatMap(([calledCommand, args]) => {
    if (calledCommand !== command) return []
    return [(args as { input: Record<string, unknown> }).input]
  })
}

function emitLifecycle(event: string, payload: unknown): void {
  for (const handler of [...(eventHandlers.get(event) ?? [])]) {
    handler({ event, id: 1, payload })
  }
}

describe('TauriStdioMcpConnector', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    eventHandlers.clear()
    unlistenMocks.length = 0
    listenMock.mockImplementation(async (event, handler) => {
      const eventName = String(event)
      const callback = handler as TestEventHandler
      const handlers = eventHandlers.get(eventName) ?? new Set<TestEventHandler>()
      handlers.add(callback)
      eventHandlers.set(eventName, handlers)
      const unlisten = vi.fn(() => {
        handlers.delete(callback)
      })
      unlistenMocks.push(unlisten)
      return unlisten
    })
  })

  it('通过结构化 Tauri 命令连接、列工具、调用并幂等注销', async () => {
    mockSuccessfulConnect()
    invokeMock
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'echo',
            description: '回显输入',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { echoed: true },
        isError: false,
        _meta: { traceId: 'trace-1' },
      })
      .mockResolvedValueOnce({ serverId: 'local', forcedKill: false })

    const connector = createTauriStdioMcpConnector()
    const connection = await connector.connect({
      id: 'local',
      name: '本地服务',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/workspace',
    })

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'mcp_connect', {
      input: expect.objectContaining({
        serverId: 'local',
        sessionToken: expect.any(String),
        command: 'node',
        args: ['server.js'],
        cwd: '/workspace',
      }),
    })
    const sessionToken = commandInputs('mcp_connect')[0]?.sessionToken
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
    expect(commandInputs('mcp_list_tools')[0]?.sessionToken).toBe(sessionToken)
    expect(commandInputs('mcp_call_tool')[0]?.sessionToken).toBe(sessionToken)
    expect(commandInputs('mcp_disconnect')[0]?.sessionToken).toBe(sessionToken)
    expect(unlistenMocks).toHaveLength(2)
    expect(unlistenMocks.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true)
  })

  it('拒绝把 HTTP 配置交给 stdio connector', async () => {
    const connector = createTauriStdioMcpConnector()
    await expect(connector.connect({
      id: 'remote',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
    })).rejects.toThrow('不支持传输')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('把 Rust 传输关闭错误通知给连接管理器且不暴露子进程 stderr', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce({
      kind: 'transport_closed',
      message: 'MCP server transport is closed',
      serverId: 'local',
      stderrTail: 'API_KEY=should-never-reach-the-model',
    })

    const connection = await createTauriStdioMcpConnector().connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })
    const onClose = vi.fn()
    connection.onClose(onClose)

    await expect(connection.callTool('echo', {})).rejects.toThrow(
      'MCP server transport is closed',
    )
    await expect(connection.callTool('echo', {})).rejects.not.toThrow('API_KEY')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('拒绝把被分页上限截断的工具列表当成完整快照', async () => {
    mockSuccessfulConnect()
    invokeMock.mockResolvedValueOnce({
      tools: [{ name: 'partial', inputSchema: { type: 'object' } }],
      truncated: true,
    })

    const connection = await createTauriStdioMcpConnector().connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })

    await expect(connection.listTools()).rejects.toThrow('超过桌面端分页上限')
  })

  it('严格拒绝缺失或非对象的 inputSchema', async () => {
    mockSuccessfulConnect()
    const connection = await createTauriStdioMcpConnector().connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })

    for (const inputSchema of [undefined, null, [], 'string']) {
      invokeMock.mockResolvedValueOnce({
        tools: [{
          name: 'invalid-schema',
          ...(inputSchema === undefined ? {} : { inputSchema }),
        }],
      })
      await expect(connection.listTools()).rejects.toThrow(
        'inputSchema 必须是对象',
      )
    }
  })

  it('注销已退出的会话仍视为成功', async () => {
    mockSuccessfulConnect()
    invokeMock.mockRejectedValueOnce({
      kind: 'not_connected',
      message: 'MCP server is not connected',
      serverId: 'local',
    })

    const connection = await createTauriStdioMcpConnector().connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })

    await expect(connection.close()).resolves.toBeUndefined()
  })

  it('忽略旧 session 的生命周期事件，并只向当前连接转发匹配事件', async () => {
    mockSuccessfulConnect()
    const connector = createTauriStdioMcpConnector()
    const oldConnection = await connector.connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })
    const oldSessionToken = commandInputs('mcp_connect')[0]?.sessionToken
    invokeMock.mockResolvedValueOnce({
      serverId: 'local',
      sessionToken: oldSessionToken,
      forcedKill: false,
    })
    await oldConnection.close()

    mockSuccessfulConnect()
    const connection = await connector.connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })
    const sessionToken = commandInputs('mcp_connect')[1]?.sessionToken
    expect(sessionToken).not.toBe(oldSessionToken)

    const onToolsChanged = vi.fn()
    const onClose = vi.fn()
    connection.onToolsChanged(onToolsChanged)
    connection.onClose(onClose)

    emitLifecycle('mcp-stdio-tools-changed', {
      serverId: 'local',
      sessionToken: oldSessionToken,
    })
    emitLifecycle('mcp-stdio-close', {
      serverId: 'local',
      sessionToken: oldSessionToken,
      message: 'old session stopped',
    })
    emitLifecycle('mcp-stdio-close', {
      serverId: 'another-server',
      sessionToken,
      message: 'another server stopped',
    })
    expect(onToolsChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    emitLifecycle('mcp-stdio-tools-changed', {
      serverId: 'local',
      sessionToken,
    })
    expect(onToolsChanged).toHaveBeenCalledOnce()

    emitLifecycle('mcp-stdio-close', {
      serverId: 'local',
      sessionToken,
      message: 'current session stopped',
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'current session stopped' }),
    )
    expect(eventHandlers.get('mcp-stdio-tools-changed')).toHaveLength(0)
    expect(eventHandlers.get('mcp-stdio-close')).toHaveLength(0)
    await expect(connection.listTools()).rejects.toThrow('current session stopped')

    invokeMock.mockResolvedValueOnce({
      serverId: 'local',
      sessionToken,
      forcedKill: false,
    })
    await connection.close()
    expect(commandInputs('mcp_disconnect').at(-1)?.sessionToken).toBe(sessionToken)
    expect(unlistenMocks).toHaveLength(4)
    expect(unlistenMocks.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true)
  })

  it('Rust 连接失败时解绑已注册的生命周期监听器', async () => {
    invokeMock.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(createTauriStdioMcpConnector().connect({
      id: 'local',
      transport: 'stdio',
      command: 'missing-command',
    })).rejects.toThrow('spawn failed')

    expect(unlistenMocks).toHaveLength(2)
    expect(unlistenMocks.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true)
    expect(eventHandlers.get('mcp-stdio-tools-changed')).toHaveLength(0)
    expect(eventHandlers.get('mcp-stdio-close')).toHaveLength(0)
  })

  it('连接被取消后用旧 token 清理迟到进程，不影响同 ID 的新连接', async () => {
    let finishConnect!: (value: unknown) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishConnect = resolve
    }))

    const controller = new AbortController()
    const connector = createTauriStdioMcpConnector()
    const pending = connector.connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    }, { signal: controller.signal })

    await vi.waitFor(() => {
      expect(commandInputs('mcp_connect')).toHaveLength(1)
    })
    const oldSessionToken = commandInputs('mcp_connect')[0]?.sessionToken
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    let finishStaleDisconnect!: (value: unknown) => void
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishStaleDisconnect = resolve
    }))
    finishConnect({
      serverId: 'local',
      sessionToken: oldSessionToken,
      pid: 123,
    })
    await vi.waitFor(() => {
      expect(commandInputs('mcp_disconnect')).toHaveLength(1)
    })
    expect(commandInputs('mcp_disconnect')[0]).toEqual({
      serverId: 'local',
      sessionToken: oldSessionToken,
      gracePeriodMs: 500,
    })

    mockSuccessfulConnect()
    const connection = await connector.connect({
      id: 'local',
      transport: 'stdio',
      command: 'node',
    })
    const sessionToken = commandInputs('mcp_connect')[1]?.sessionToken
    expect(sessionToken).not.toBe(oldSessionToken)

    invokeMock.mockResolvedValueOnce({ tools: [] })
    await expect(connection.listTools()).resolves.toEqual([])
    expect(commandInputs('mcp_list_tools')[0]?.sessionToken).toBe(sessionToken)

    finishStaleDisconnect({
      serverId: 'local',
      sessionToken: oldSessionToken,
      forcedKill: false,
    })
    invokeMock.mockResolvedValueOnce({
      serverId: 'local',
      sessionToken,
      forcedKill: false,
    })
    await connection.close()
    expect(commandInputs('mcp_disconnect')[1]?.sessionToken).toBe(sessionToken)
  })
})
