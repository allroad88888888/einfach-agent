// connect_mcp_server 的功能契约与注册器契约。
// 提示注入场景（拒绝 URL / 命令行 / 配置对象 / 未登记 id）在 connect-mcp-server.injection.test.ts。
import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { describe, expect, it, vi } from 'vitest'
import { registerMcpTools } from '../index'
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../toolAdapter'
import {
  fakeManager,
  serverSnapshot,
  toolContext,
  toolSnapshot,
} from './connect-mcp-server.fixtures'
import {
  MCP_CONNECT_MAX_LISTED_TOOLS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CONNECT_TOOL_NAME,
  createMcpConnectTool,
  type McpConnectManager,
} from './connect-mcp-server'

describe('connect_mcp_server', () => {
  it('connects a configured server and reports the tools it just registered', async () => {
    const connected = serverSnapshot('weather', 'connected', [
      toolSnapshot('mcp__weather__forecast', 'D'.repeat(400)),
    ])
    const { manager, reconnect } = fakeManager(
      [serverSnapshot('weather', 'disconnected')],
      { onReconnect: () => connected },
    )
    const progress = vi.fn()

    const result = await createMcpConnectTool(manager).execute(
      { serverId: 'weather' },
      { ...toolContext(), progress },
    )

    expect(reconnect).toHaveBeenCalledWith('weather', { signal: expect.any(AbortSignal) })
    expect(progress).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      data: {
        serverId: 'weather',
        transport: 'streamable-http',
        status: 'connected',
        alreadyConnected: false,
        toolCount: 1,
        tools: [{ name: 'mcp__weather__forecast' }],
      },
    })
    // 结果里不能捎带连接配置：url / headers 可能含凭据。
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET_TOKEN')
    expect(serialized).not.toContain('mcp.example.test')
    if ('ok' in result && result.ok === true) {
      const data = result.data as { tools: Array<{ description: string }> }
      expect(data.tools[0]?.description.length).toBeLessThanOrEqual(160)
    }
  })

  it('bounds an oversized tool list instead of dumping every remote tool', async () => {
    const tools = Array.from({ length: MCP_CONNECT_MAX_LISTED_TOOLS + 7 }, (_unused, index) =>
      toolSnapshot(`mcp__bulk__tool_${index}`))
    const { manager } = fakeManager([serverSnapshot('bulk', 'connected', tools)])

    const result = await createMcpConnectTool(manager).execute(
      { serverId: 'bulk' },
      toolContext(),
    )

    expect(result).toMatchObject({
      ok: true,
      data: { toolCount: MCP_CONNECT_MAX_LISTED_TOOLS + 7, omittedTools: 7 },
    })
    if ('ok' in result && result.ok === true) {
      expect((result.data as { tools: unknown[] }).tools).toHaveLength(
        MCP_CONNECT_MAX_LISTED_TOOLS,
      )
    }
  })

  it('does not tear down a live connection when the server is already connected', async () => {
    const { manager, reconnect } = fakeManager([
      serverSnapshot('weather', 'connected', [toolSnapshot('mcp__weather__forecast')]),
    ])

    await expect(
      createMcpConnectTool(manager).execute({ serverId: ' weather ' }, toolContext()),
    ).resolves.toMatchObject({
      ok: true,
      data: { alreadyConnected: true, toolCount: 1 },
    })
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('reports a permanent connection failure as bounded and non-retryable', async () => {
    // "unsupported mcp transport" 是这个包自己抛的开发者字符串（validateConfig），
    // 命中 classifyMcpFailure() 的永久失败规则（config_invalid）。
    const { manager } = fakeManager([serverSnapshot('weather', 'error')], {
      onReconnect: () => {
        throw new Error(`unsupported mcp transport: E${'!'.repeat(20_000)}`)
      },
    })

    const result = await createMcpConnectTool(manager).execute(
      { serverId: 'weather' },
      toolContext(),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_FAILED',
      retryable: false,
      details: {
        serverId: 'weather',
        transport: 'streamable-http',
        status: 'error',
        reason: 'config_invalid',
      },
    })
    if ('error' in result) {
      expect(result.error.length).toBeLessThanOrEqual(4_100)
      expect(result.error.endsWith('…')).toBe(true)
      expect(result.hint).toContain('不要原样重试')
    }
  })

  it('reports a temporary connection failure (network jitter) as retryable', async () => {
    // 不命中任何永久规则的错误 → classifyMcpFailure() 的兜底 'connection_disrupted'，可重试。
    const { manager } = fakeManager([serverSnapshot('weather', 'reconnecting')], {
      onReconnect: () => {
        throw new Error('socket hang up')
      },
    })

    const result = await createMcpConnectTool(manager).execute(
      { serverId: 'weather' },
      toolContext(),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_FAILED',
      retryable: true,
      details: {
        serverId: 'weather',
        transport: 'streamable-http',
        status: 'reconnecting',
        reason: 'connection_disrupted',
      },
    })
  })

  it('reports a connect timeout as its own bounded, retryable result — independent of the tool-call timeout', async () => {
    const pending = new Promise<never>(() => {
      // 永不落地：只有工具自己的连接超时能让 execute() 返回。
    })
    const manager: McpConnectManager = {
      get: () => serverSnapshot('slow', 'disconnected'),
      list: () => [serverSnapshot('slow', 'disconnected')],
      reconnect: vi.fn(() => pending),
    }

    const result = await createMcpConnectTool(manager, { connectTimeoutMs: 20 }).execute(
      { serverId: 'slow' },
      toolContext(),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_TIMEOUT',
      retryable: true,
      details: { serverId: 'slow', transport: 'streamable-http', timeoutMs: 20 },
    })
  })

  it('defaults the connect timeout to MCP_CONNECT_TIMEOUT_MS, independent from the tool-call timeout', () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBe(180_000)
    expect(MCP_CONNECT_TIMEOUT_MS).not.toBe(MCP_TOOL_CALL_TIMEOUT_MS)
  })

  it('keeps caller cancellation as AbortError control flow', async () => {
    const controller = new AbortController()
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')], {
      onReconnect: () => {
        controller.abort(new Error('cancelled by caller'))
        throw new Error('transport torn down')
      },
    })

    await expect(
      createMcpConnectTool(manager).execute(
        { serverId: 'weather' },
        toolContext(controller.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled by caller' })
  })

  it('declares an internal, serial tool with a stable effect key', () => {
    const { manager } = fakeManager([])
    const tool = createMcpConnectTool(manager)

    expect(tool.name).toBe(MCP_CONNECT_TOOL_NAME)
    expect(tool.runtime).toBe('internal')
    expect(tool.execution).toEqual({
      mode: 'serial',
      effectKeys: ['external:mcp:connect'],
    })
    expect(tool.inputSchema).toMatchObject({
      required: ['serverId'],
      additionalProperties: false,
      properties: { serverId: { type: 'string' } },
    })
    expect(tool.skill.content).toContain('只接受已配置服务的 ID')
  })
})

describe('registerMcpTools', () => {
  it('registers the connect tool against the injected manager', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    const registry = createToolRegistry()

    registerMcpTools(registry, { manager })

    expect(registry.has(MCP_CONNECT_TOOL_NAME)).toBe(true)
    expect(registry.list().map((summary) => summary.name)).toContain(MCP_CONNECT_TOOL_NAME)
    expect(registry.loadSchema(MCP_CONNECT_TOOL_NAME)?.guide).toContain('connect_mcp_server')
  })

  it('fails at wiring time when the runtime dependency is missing', () => {
    const registry = createToolRegistry()

    expect(() => registerMcpTools(registry, undefined as never)).toThrow(
      'requires an MCP client manager',
    )
    expect(() => registerMcpTools(registry, {} as never)).toThrow(
      'requires an MCP client manager',
    )
    expect(registry.has(MCP_CONNECT_TOOL_NAME)).toBe(false)
  })
})
