import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_MS,
  FakeConnection,
  HTTP_CONFIG,
  advance,
  authError,
  connected,
  dropConnection,
  remoteTool,
  settle,
  temporaryError,
} from './clientManager.reconnect.fixtures'

/** 「什么时候重试、还能重试几次」：退避序列、次数上限、永久失败不重试。 */
describe('McpClientManager backoff schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries on 1s→2s→4s→8s→16s→30s and then fails permanently', async () => {
    const { registry, connector, manager, live, status } = await connected()
    expect(registry.has('mcp__remote__alpha')).toBe(true)

    await dropConnection(live)
    expect(status()).toBe('reconnecting')
    expect(registry.has('mcp__remote__alpha')).toBe(false)
    expect(connector.connectCount).toBe(1)

    for (const [index, delayMs] of BACKOFF_MS.entries()) {
      await advance(delayMs - 1)
      expect(connector.connectCount).toBe(index + 1)
      await advance(1)
      expect(connector.connectCount).toBe(index + 2)
    }

    const snapshot = manager.get(HTTP_CONFIG.id)
    expect(snapshot?.status).toBe('error')
    expect(snapshot?.error).toContain('已自动重连 6 次')
    expect(snapshot?.error).toContain('connect refused')

    await advance(300_000)
    expect(connector.connectCount).toBe(BACKOFF_MS.length + 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never retries a permanent failure', async () => {
    const { connector, manager, live, status } = await connected()

    live.emitUnexpectedClose(authError())
    await settle()
    expect(status()).toBe('error')
    expect(manager.get(HTTP_CONFIG.id)?.error).toContain('身份认证失败')
    expect(vi.getTimerCount()).toBe(0)

    await advance(300_000)
    expect(connector.connectCount).toBe(1)
  })

  it('stops the chain as soon as an attempt fails permanently', async () => {
    const { connector, manager, live, status } = await connected()
    connector.fallback = authError()

    await dropConnection(live)
    await advance(1_000)

    expect(status()).toBe('error')
    expect(manager.get(HTTP_CONFIG.id)?.error).toContain('身份认证失败')
    await advance(300_000)
    expect(connector.connectCount).toBe(2)
  })

  it('gives the budget back after a successful reconnect', async () => {
    const revived = new FakeConnection([remoteTool('beta')])
    const { connector, live, status } = await connected(temporaryError(), revived)

    await dropConnection(live)
    await advance(1_000)
    expect(connector.connectCount).toBe(2)
    await advance(2_000)
    expect(status()).toBe('connected')
    expect(connector.connectCount).toBe(3)

    // 新一条链必须重新从 1 秒起步，而不是接着 4 秒。
    await dropConnection(revived)
    await advance(999)
    expect(connector.connectCount).toBe(3)
    await advance(1)
    expect(connector.connectCount).toBe(4)
  })
})
