import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeConnection,
  HTTP_CONFIG,
  advance,
  connected,
  dropConnection,
  remoteTool,
  settle,
} from './clientManager.reconnect.fixtures'

/**
 * 「什么时候不该重试」：手动操作接管、服务被停掉/删掉、旧连接的回调迟到。
 *
 * 定时器数量一律在 advance 之前断言 —— 过期定时器落地时会被世代检查挡住，
 * 等它烧完再数就永远是 0，「服务已删除但定时器还在跑」这个缺陷会整个漏掉。
 */
describe('McpClientManager backoff cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a manual reconnect or connect interrupt a pending backoff', async () => {
    const viaReconnect = new FakeConnection([remoteTool('beta')])
    const viaConnect = new FakeConnection([remoteTool('gamma')])
    const { registry, connector, manager, live } = await connected(viaReconnect, viaConnect)

    await dropConnection(live)
    expect(vi.getTimerCount()).toBe(1)
    await expect(manager.reconnect(HTTP_CONFIG.id)).resolves.toMatchObject({
      status: 'connected',
    })
    expect(vi.getTimerCount()).toBe(0)

    await dropConnection(viaReconnect)
    expect(vi.getTimerCount()).toBe(1)
    await expect(manager.connect(HTTP_CONFIG)).resolves.toMatchObject({ status: 'connected' })
    expect(vi.getTimerCount()).toBe(0)

    await advance(300_000)
    expect(connector.connectCount).toBe(3)
    expect(registry.has('mcp__remote__gamma')).toBe(true)
  })

  it('hands the chain over to a manual attempt even when that attempt fails', async () => {
    const { connector, manager, live, status } = await connected()

    await dropConnection(live)
    expect(vi.getTimerCount()).toBe(1)
    // 手动尝试本身就是一次尝试：它失败后不能再留着上一条链的定时器，
    // 否则用户点一次「重连」会换来两条互相追赶的重试链。
    await expect(manager.reconnect(HTTP_CONFIG.id)).rejects.toThrow('connect refused')
    expect(vi.getTimerCount()).toBe(0)
    expect(status()).toBe('reconnecting')

    await advance(300_000)
    expect(connector.connectCount).toBe(2)
  })

  it('hands the chain over to a failing manual connect too', async () => {
    const revived = new FakeConnection([remoteTool('beta')])
    const { connector, manager, live } = await connected(revived)

    await dropConnection(live)
    await advance(1_000)
    await dropConnection(revived)
    expect(vi.getTimerCount()).toBe(1)

    await expect(manager.connect(HTTP_CONFIG)).rejects.toThrow('connect refused')
    expect(vi.getTimerCount()).toBe(0)
    await advance(300_000)
    expect(connector.connectCount).toBe(3)
  })

  it('cancels a pending retry on disconnect', async () => {
    const { connector, manager, live, status } = await connected()

    await dropConnection(live)
    await manager.disconnect(HTTP_CONFIG.id)
    expect(vi.getTimerCount()).toBe(0)

    await advance(300_000)
    expect(status()).toBe('disconnected')
    expect(connector.connectCount).toBe(1)
  })

  it('cancels a pending retry on remove, so a deleted server cannot re-register tools', async () => {
    const { registry, connector, manager, live } = await connected(
      new FakeConnection([remoteTool('ghost')]),
    )

    await dropConnection(live)
    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    await advance(300_000)
    expect(connector.connectCount).toBe(1)
    expect(manager.list()).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('ignores late callbacks from the connection the retry replaced', async () => {
    const revived = new FakeConnection([remoteTool('beta')])
    const { registry, connector, manager, live, status } = await connected(revived)

    await dropConnection(live)
    await advance(1_000)
    expect(status()).toBe('connected')
    expect(registry.has('mcp__remote__beta')).toBe(true)

    live.emitStaleCallbacks()
    await settle()

    expect(status()).toBe('connected')
    expect(manager.get(HTTP_CONFIG.id)?.tools.map((tool) => tool.remoteName)).toEqual(['beta'])
    expect(registry.has('mcp__remote__beta')).toBe(true)
    expect(revived.listCount).toBe(1)
    await advance(300_000)
    expect(connector.connectCount).toBe(2)
  })

  it('discards an in-flight retry that a manual reconnect overtook', async () => {
    const overtaken = new FakeConnection([remoteTool('stale')])
    const fresh = new FakeConnection([remoteTool('fresh')])
    let release!: (connection: FakeConnection) => void
    const gate = new Promise<FakeConnection>((resolve) => {
      release = resolve
    })
    const { registry, connector, manager, live } = await connected(() => gate, fresh)

    await dropConnection(live)
    await advance(1_000)
    expect(connector.connectCount).toBe(2)

    const reconnecting = manager.reconnect(HTTP_CONFIG.id)
    release(overtaken)
    await expect(reconnecting).resolves.toMatchObject({ status: 'connected' })

    expect(overtaken.closeCount).toBe(1)
    expect(registry.has('mcp__remote__stale')).toBe(false)
    expect(registry.has('mcp__remote__fresh')).toBe(true)
    await advance(300_000)
    expect(connector.connectCount).toBe(3)
  })
})
