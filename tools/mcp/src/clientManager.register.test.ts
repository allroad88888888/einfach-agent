import { createToolRegistry } from '@web-agent/core/tools'
import type { ToolContext } from '@web-agent/core/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClientManager } from './clientManager'
import {
  FakeConnection,
  HTTP_CONFIG,
  ScriptedConnector,
  advance,
  connected,
  dropConnection,
  remoteTool,
  temporaryError,
} from './clientManager.reconnect.fixtures'
import { createMcpConnectTool } from './connect-mcp-server/connect-mcp-server'

/**
 * 「已配置但从未连接」这一档记录（F6）。register() 的判据只有一条：
 * 服务进得了登记表，而这件事本身【不产生任何连接、进程或重试】。
 */

function managerWith(connector: ScriptedConnector) {
  const registry = createToolRegistry()
  return { registry, manager: new McpClientManager({ registry, connector }) }
}

/** 连接工具只用到 signal 与 progress，其余能力这里都不该被碰。 */
function toolContext(): ToolContext {
  return {
    sessionId: 'session-1',
    signal: new AbortController().signal,
    progress: () => undefined,
  } as unknown as ToolContext
}

describe('McpClientManager.register 只登记不连接', () => {
  it('让一个从未连过的服务进入登记表，且不建立任何连接', async () => {
    const connector = new ScriptedConnector([new FakeConnection([remoteTool('alpha')])])
    const { registry, manager } = managerWith(connector)
    const observer = vi.fn()
    manager.subscribe(observer)

    const snapshot = await manager.register(HTTP_CONFIG)

    expect(snapshot).toMatchObject({
      id: HTTP_CONFIG.id,
      status: 'disconnected',
      tools: [],
    })
    expect(snapshot.error).toBeUndefined()
    expect(manager.get(HTTP_CONFIG.id)).toMatchObject({ status: 'disconnected' })
    expect(manager.list().map((server) => server.id)).toEqual([HTTP_CONFIG.id])
    expect(manager.listTools()).toEqual([])
    // 没有连接、没有请求、没有进程，registry 里也不该多出任何远端工具。
    expect(connector.connectCount).toBe(0)
    expect(registry.list()).toEqual([])
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: HTTP_CONFIG.id, status: 'disconnected' }),
    ])

    // 重复登记是无副作用的：连记录变更广播都不该再发一次。
    await manager.register(HTTP_CONFIG)
    expect(manager.list()).toHaveLength(1)
    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('重复登记不覆盖一条正连着的记录', async () => {
    const { registry, connector, manager } = await connected()
    expect(registry.has('mcp__remote__alpha')).toBe(true)

    await expect(manager.register(HTTP_CONFIG)).resolves.toMatchObject({
      status: 'connected',
    })

    expect(manager.get(HTTP_CONFIG.id)?.tools).toHaveLength(1)
    expect(registry.has('mcp__remote__alpha')).toBe(true)
    expect(connector.connectCount).toBe(1)
  })

  it('对只登记的服务 disconnect 幂等，remove 让它彻底消失', async () => {
    const connector = new ScriptedConnector([])
    const { manager } = managerWith(connector)
    await manager.register(HTTP_CONFIG)

    // 断开一条本来就没有的连接不是错误，也不该退化成 undefined：记录还在，
    // 状态就还能回答「现在没连上」。
    await expect(manager.disconnect(HTTP_CONFIG.id)).resolves.toMatchObject({
      id: HTTP_CONFIG.id,
      status: 'disconnected',
      tools: [],
    })
    expect(manager.get(HTTP_CONFIG.id)).toBeDefined()

    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(true)
    expect(manager.get(HTTP_CONFIG.id)).toBeUndefined()
    expect(manager.list()).toEqual([])
    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(false)
    expect(connector.connectCount).toBe(0)
  })

  it('非法配置当场拒绝，不留下半条记录', () => {
    const { manager } = managerWith(new ScriptedConnector([]))

    // 与 connect() 同一条校验、同一种抛法（同步抛，见 serverConfig.validateConfig）。
    expect(() =>
      manager.register({ id: 'bad-url', transport: 'streamable-http', url: 'ftp://nope' }),
    ).toThrow('http or https')
    expect(() =>
      manager.register({ id: '   ', transport: 'stdio', command: 'mcp-files' }),
    ).toThrow('id must not be empty')

    expect(manager.list()).toEqual([])
  })

  it('connect_mcp_server 能连上一个只登记、从未连过的服务', async () => {
    const connector = new ScriptedConnector([new FakeConnection([remoteTool('alpha')])])
    const { registry, manager } = managerWith(connector)
    await manager.register(HTTP_CONFIG)

    const tool = createMcpConnectTool(manager)
    const result = await tool.execute({ serverId: HTTP_CONFIG.id }, toolContext())

    // 登记之前这里只会得到 MCP_SERVER_NOT_CONFIGURED —— 按需连接的整条路径就断在那里。
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    expect(manager.get(HTTP_CONFIG.id)?.status).toBe('connected')
    expect(registry.has('mcp__remote__alpha')).toBe(true)
    expect(connector.connectCount).toBe(1)
  })
})

describe('只登记的记录与退避重连', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('从未连过 ≠ 断线了：登记不排任何重试定时器', async () => {
    const connector = new ScriptedConnector([])
    const { manager } = managerWith(connector)

    await manager.register(HTTP_CONFIG)

    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(connector.connectCount).toBe(0)
    expect(manager.get(HTTP_CONFIG.id)?.status).toBe('disconnected')
  })

  it('登记一个正在退避的服务，既不打断挂起的重试也不退还预算', async () => {
    const revived = new FakeConnection([remoteTool('beta')])
    const { connector, manager, live, status } = await connected(temporaryError(), revived)
    await dropConnection(live)
    expect(status()).toBe('reconnecting')

    await manager.register(HTTP_CONFIG)
    expect(status()).toBe('reconnecting')

    // 第一次重试仍在原定时刻触发：既没被取消，也没被重排。
    await advance(999)
    expect(connector.connectCount).toBe(1)
    await advance(1)
    expect(connector.connectCount).toBe(2)

    // 预算也没回到 0：第二次仍然等 2 秒，而不是重新从 1 秒起步。
    await advance(1_999)
    expect(connector.connectCount).toBe(2)
    await advance(1)
    expect(connector.connectCount).toBe(3)
    expect(status()).toBe('connected')
  })
})
