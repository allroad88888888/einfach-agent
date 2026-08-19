import { createToolRegistry } from '@einfach-agent/core/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClientManager } from './clientManager'
import {
  BACKOFF_MS,
  FakeConnection,
  HTTP_CONFIG,
  ScriptedConnector,
  advance,
  connected,
  dropConnection,
  remoteTool,
  temporaryError,
  type ConnectStep,
} from './clientManager.reconnect.fixtures'
import type { McpOperationOptions } from './types'

/**
 * 保活探活接进连接状态机之后的行为：谁会被探、探出死连接之后交给谁、以及【谁绝对不能被碰】
 * （只登记未连接的记录、正在退避重连的记录、已经退役的连接）。
 *
 * 定时器数量一律在 advance 之前断言：过期定时器落地时会被世代检查挡住，等它烧完再数
 * 就永远是 0，「连接已退役但保活表还在跑」这个缺陷会整个漏掉。
 */

/** 实现了轻量 ping 的连接。不实现 ping 的连接见 FakeConnection —— 它不会被探活。 */
class PingableConnection extends FakeConnection {
  pingCount = 0
  abortCount = 0
  /** 设成 Error 后每次探活都以它失败。 */
  pingFailure: Error | undefined
  /** true 时探活不自行结算，只能被超时或取消掐断 —— 这就是「静默的连接」。 */
  hangPing = false
  /** true 时无视取消信号：模拟一次谁也掐不掉、只能等它自己超时的迟到探活。 */
  ignoreAbort = false

  ping = (options?: McpOperationOptions): Promise<void> => {
    this.pingCount += 1
    if (this.pingFailure) return Promise.reject(this.pingFailure)
    if (!this.hangPing) return Promise.resolve()
    return new Promise<void>((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        this.abortCount += 1
        if (!this.ignoreAbort) reject(new Error('探活已取消'))
      })
    })
  }
}

/** 连上一条【支持探活】的连接，随后可以让它静默或失败。 */
async function connectedPingable(...laterSteps: ConnectStep[]) {
  const registry = createToolRegistry()
  const live = new PingableConnection([remoteTool('alpha')])
  const connector = new ScriptedConnector([live, ...laterSteps])
  const manager = new McpClientManager({ registry, connector })
  await manager.connect(HTTP_CONFIG)
  return {
    registry,
    connector,
    manager,
    live,
    status: () => manager.get(HTTP_CONFIG.id)?.status,
    error: () => manager.get(HTTP_CONFIG.id)?.error,
  }
}

describe('McpClientManager keepalive 探活', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('空闲连接被周期性探活，而探活不触发任何工具对账', async () => {
    const { manager, registry, live, status } = await connectedPingable()
    const observer = vi.fn()
    manager.subscribe(observer)
    // 连上即起表，而且只有这一个定时器。
    expect(vi.getTimerCount()).toBe(1)

    await advance(29_999)
    expect(live.pingCount).toBe(0)
    await advance(1)
    expect(live.pingCount).toBe(1)
    await advance(30_000)
    expect(live.pingCount).toBe(2)

    expect(status()).toBe('connected')
    // 全程只在连接时对过一次账：拿 listTools 当心跳的话这里会是 3。
    expect(live.listCount).toBe(1)
    expect(registry.has('mcp__remote__alpha')).toBe(true)
    // 探活成功不改变任何对外状态，也就不该广播。
    expect(observer).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('不实现 ping 的连接不被探活，也不排任何定时器', async () => {
    const { live, status } = await connected()

    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(status()).toBe('connected')
    expect(live.listCount).toBe(1)
  })

  it('连续两次探活不通才判死，然后整条交给退避重连', async () => {
    const revived = new PingableConnection([remoteTool('beta')])
    const { registry, connector, live, status, error } = await connectedPingable(revived)
    live.pingFailure = temporaryError('socket hung up')

    // 一次不通不判死：可能只是这一个请求赶上了瞬时拥塞。
    await advance(30_000)
    expect(live.pingCount).toBe(1)
    expect(status()).toBe('connected')
    expect(error()).toBeUndefined()
    expect(registry.has('mcp__remote__alpha')).toBe(true)

    await advance(30_000)
    expect(live.pingCount).toBe(2)
    expect(status()).toBe('reconnecting')
    // 判死走的是与「意外关闭」同一条路：工具下线、连接关闭、错误按同一套分类写。
    expect(registry.has('mcp__remote__alpha')).toBe(false)
    expect(live.closeCount).toBe(1)
    expect(error()).toContain('连接暂时中断')
    expect(error()).toContain('socket hung up')
    // 保活表已撤，只剩 D2 的退避定时器。
    expect(vi.getTimerCount()).toBe(1)

    // 交给 D2 之后就是一条普通的重连链：第一次重试仍然是 1 秒。
    await advance(999)
    expect(connector.connectCount).toBe(1)
    await advance(1)
    expect(connector.connectCount).toBe(2)
    expect(status()).toBe('connected')
    expect(registry.has('mcp__remote__beta')).toBe(true)

    // 新连接起了自己的表，而且是从换代那一刻重新计时。
    expect(vi.getTimerCount()).toBe(1)
    await advance(29_999)
    expect(revived.pingCount).toBe(0)
    await advance(1)
    expect(revived.pingCount).toBe(1)
  })

  it('静默的连接靠探活超时被发现，而不是等下一次真实调用', async () => {
    const { live, status, error } = await connectedPingable()
    live.hangPing = true

    await advance(30_000)
    expect(live.pingCount).toBe(1)
    // 探活在飞时挂着的是它的超时定时器，不是下一次探活。
    expect(vi.getTimerCount()).toBe(1)

    await advance(9_999)
    expect(status()).toBe('connected')
    await advance(1)
    // 超时把在飞的探活掐掉，并只记一次不通。
    expect(live.abortCount).toBe(1)
    expect(status()).toBe('connected')

    await advance(30_000 + 10_000)
    expect(live.pingCount).toBe(2)
    expect(status()).toBe('reconnecting')
    expect(error()).toContain('连接暂时中断')
    expect(error()).toContain('保活探测超时')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('只登记未连接的服务不被探活：没有连接可探，也不会因此重连', async () => {
    const connector = new ScriptedConnector([])
    const registry = createToolRegistry()
    const manager = new McpClientManager({ registry, connector })

    await manager.register(HTTP_CONFIG)

    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(connector.connectCount).toBe(0)
    expect(manager.get(HTTP_CONFIG.id)?.status).toBe('disconnected')
    expect(manager.get(HTTP_CONFIG.id)?.error).toBeUndefined()
  })

  it('正在退避重连的记录不被探活干扰：预算与节奏都不变', async () => {
    const { connector, manager, live, status } = await connectedPingable()

    await dropConnection(live)
    expect(status()).toBe('reconnecting')
    // 连接一退役保活表就停了：这里只剩退避定时器。多出来的那一个就是叠加的证据。
    expect(vi.getTimerCount()).toBe(1)

    // 整条重连链跨过 61 秒（两个探活周期）：节奏与次数必须与没有保活时一模一样。
    for (const [index, delayMs] of BACKOFF_MS.entries()) {
      await advance(delayMs - 1)
      expect(connector.connectCount).toBe(index + 1)
      await advance(1)
      expect(connector.connectCount).toBe(index + 2)
    }

    expect(status()).toBe('error')
    expect(manager.get(HTTP_CONFIG.id)?.error).toContain('已自动重连 6 次')
    expect(live.pingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('断开清干净保活表，删除之后更不留下任何定时器', async () => {
    const { manager, live } = await connectedPingable()
    expect(vi.getTimerCount()).toBe(1)

    await manager.disconnect(HTTP_CONFIG.id)
    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(live.pingCount).toBe(0)
    expect(manager.get(HTTP_CONFIG.id)?.status).toBe('disconnected')

    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(live.pingCount).toBe(0)
    expect(manager.list()).toEqual([])
  })

  it('探活在飞时断开：探活被掐掉，超时定时器不留', async () => {
    const { manager, live, status } = await connectedPingable()
    live.hangPing = true

    await advance(30_000)
    expect(live.pingCount).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    await manager.disconnect(HTTP_CONFIG.id)
    expect(live.abortCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(status()).toBe('disconnected')

    await advance(300_000)
    expect(status()).toBe('disconnected')
    expect(live.pingCount).toBe(1)
  })

  it('旧连接迟到的探活既不判死新连接，也不打乱它的节奏', async () => {
    const fresh = new PingableConnection([remoteTool('beta')])
    const { registry, manager, live, status } = await connectedPingable(fresh)
    live.hangPing = true
    // 这条探活谁也掐不掉，只能等它自己超时 —— 世代检查唯一真正要挡住的东西。
    live.ignoreAbort = true

    await advance(30_000)
    expect(live.pingCount).toBe(1)

    await expect(manager.reconnect(HTTP_CONFIG.id)).resolves.toMatchObject({
      status: 'connected',
    })
    expect(live.abortCount).toBe(1)
    // 新连接的探活定时器 + 旧探活那个还没烧完的超时定时器。后者上限 10 秒，自会清掉。
    expect(vi.getTimerCount()).toBe(2)

    await advance(10_000)
    expect(status()).toBe('connected')
    expect(registry.has('mcp__remote__beta')).toBe(true)
    expect(fresh.pingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(1)

    // 新连接从换代那一刻重新计时：30 秒后才轮到它第一次探活。
    await advance(20_000)
    expect(fresh.pingCount).toBe(1)
    expect(status()).toBe('connected')
    expect(live.pingCount).toBe(1)
  })
})
