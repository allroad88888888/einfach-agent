import { describe, expect, it, vi } from 'vitest'
import {
  createServerHostEventStream,
  isServerHostEventName,
  type ServerHostEvent,
} from './serverHostEventStream'
import {
  createSseFetchHarness,
  fakeTokenEnvironment,
  sseFrame,
  streamEncoder,
  type SseFetchHarness,
} from './serverHostEventStream.testHarness'

interface Collected {
  readonly events: ServerHostEvent[]
  readonly connects: number[]
  readonly errors: unknown[]
}

/** 起一条流并跑完 `body`，无论成败都退订——漏了就是一个永远重连下去的循环。 */
async function withStream(
  harness: SseFetchHarness,
  body: (collected: Collected) => Promise<void>,
  options: { readonly token?: string } = { token: 'tok-1' },
): Promise<void> {
  const collected: Collected = { events: [], connects: [], errors: [] }
  const stream = createServerHostEventStream({
    fetch: harness.fetchImpl,
    tokenEnvironment: fakeTokenEnvironment(options.token),
    initialReconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    onStreamError: (error) => { collected.errors.push(error) },
  })
  const unsubscribe = stream.subscribe({
    onEvent: (event) => { collected.events.push(event) },
    onStreamConnected: () => { collected.connects.push(collected.connects.length) },
  })
  try {
    await body(collected)
  } finally {
    unsubscribe()
  }
}

describe('isServerHostEventName', () => {
  it('只认 host-node 登记在册的两个事件名', () => {
    expect(isServerHostEventName('mcp-stdio-close')).toBe(true)
    expect(isServerHostEventName('mcp-stdio-tools-changed')).toBe(true)
    expect(isServerHostEventName('mcp-stdio-closed')).toBe(false)
    // Set 而不是对象查表：`Object.prototype` 上的键不许蒙混过去。
    expect(isServerHostEventName('toString')).toBe(false)
    expect(isServerHostEventName(undefined)).toBe(false)
  })
})

describe('createServerHostEventStream', () => {
  it('把一帧 SSE 解析成事件交给订阅方', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      harness.connections[0]!.push(sseFrame('mcp-stdio-close', {
        serverId: 'local',
        sessionToken: 's-1',
        message: '子进程退出了',
      }))
      await vi.waitFor(() => { expect(collected.events).toHaveLength(1) })
      expect(collected.events[0]).toEqual({
        name: 'mcp-stdio-close',
        payload: { serverId: 'local', sessionToken: 's-1', message: '子进程退出了' },
      })
    })
  })

  it('带 Authorization: Bearer，不退回 ?token=', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async () => {
      await vi.waitFor(() => { expect(harness.calls).toHaveLength(1) })
      expect(harness.calls[0]?.headers.authorization).toBe('Bearer tok-1')
      expect(harness.calls[0]?.headers.accept).toBe('text/event-stream')
    })
  })

  it('拿不到 token 时不带那个头，交给服务端给出准确的 401', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async () => {
      await vi.waitFor(() => { expect(harness.calls).toHaveLength(1) })
      expect(harness.calls[0]?.headers.authorization).toBeUndefined()
    }, { token: undefined })
  })

  it('每次连上都报一次 onStreamConnected —— 包括第一次', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(collected.connects).toHaveLength(1) })
      // 服务端重启：这条流结束 → 客户端重连 → 第二次连上必须再报一次。
      harness.connections[0]!.end()
      await vi.waitFor(() => { expect(collected.connects).toHaveLength(2) })
      expect(harness.connections).toHaveLength(2)
    })
  })

  it('心跳注释行不产生事件', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      harness.connections[0]!.push(': connected\n: heartbeat\n')
      harness.connections[0]!.push(sseFrame('mcp-stdio-tools-changed', { serverId: 'a', sessionToken: 'b' }))
      await vi.waitFor(() => { expect(collected.events).toHaveLength(1) })
      expect(collected.events[0]?.name).toBe('mcp-stdio-tools-changed')
    })
  })

  it('认不出的事件名静默丢弃，不往下传一个类型上不存在的名字', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      harness.connections[0]!.push(sseFrame('mcp-stdio-closed', { serverId: 'a' }))
      harness.connections[0]!.push(sseFrame('mcp-stdio-close', { serverId: 'a', sessionToken: 'b', message: 'x' }))
      await vi.waitFor(() => { expect(collected.events).toHaveLength(1) })
      expect(collected.events[0]?.name).toBe('mcp-stdio-close')
    })
  })

  it('载荷不是 JSON / 不是对象时不派发', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      harness.connections[0]!.push('event: mcp-stdio-close\ndata: 不是 JSON\n\n')
      harness.connections[0]!.push('event: mcp-stdio-close\ndata: [1,2]\n\n')
      await vi.waitFor(() => { expect(collected.errors).toHaveLength(1) })
      expect(collected.events).toEqual([])
    })
  })

  it('多字节字符被切开也不坏字', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      const bytes = streamEncoder.encode(sseFrame('mcp-stdio-close', {
        serverId: 'local',
        sessionToken: 's-1',
        message: '中文与🌱',
      }))
      // 逐字节喂：每个多字节序列都被切开了。
      for (const byte of bytes) harness.connections[0]!.pushBytes(new Uint8Array([byte]))
      await vi.waitFor(() => { expect(collected.events).toHaveLength(1) })
      expect(collected.events[0]?.payload.message).toBe('中文与🌱')
    })
  })

  it('非 200 不算连上，退避后继续重试', async () => {
    const harness = createSseFetchHarness()
    harness.plan([401, 401, 'stream'])
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(collected.connects).toHaveLength(1) })
      expect(harness.calls.length).toBeGreaterThanOrEqual(3)
      expect(collected.errors.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('连不上（网络层失败）时也继续重试', async () => {
    const harness = createSseFetchHarness()
    harness.plan(['network-error', 'stream'])
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(collected.connects).toHaveLength(1) })
      expect(harness.calls).toHaveLength(2)
    })
  })

  it('流中途报错按断线处理：报一次错并重连', async () => {
    const harness = createSseFetchHarness()
    await withStream(harness, async (collected) => {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      harness.connections[0]!.fail(new Error('socket hang up'))
      await vi.waitFor(() => { expect(collected.connects).toHaveLength(2) })
      expect(collected.errors.map((error) => (error as Error).message)).toContain('socket hang up')
    })
  })

  it('最后一个订阅方退订：请求被取消、reader 被 cancel、不再重连', async () => {
    const harness = createSseFetchHarness()
    const stream = createServerHostEventStream({
      fetch: harness.fetchImpl,
      tokenEnvironment: fakeTokenEnvironment('tok-1'),
      initialReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })
    const unsubscribe = stream.subscribe({ onEvent: () => {}, onStreamConnected: () => {} })
    await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })

    unsubscribe()
    expect(harness.calls[0]?.signal.aborted).toBe(true)
    // 读取循环停在 `read()` 上；退订之后即使服务端再结束这条响应，也不许再开新连接。
    harness.connections[0]!.end()
    await vi.waitFor(() => { expect(harness.connections[0]!.cancelled()).toBe(true) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(harness.connections).toHaveLength(1)
    expect(harness.calls).toHaveLength(1)
  })

  it('两个订阅方共用一条连接，走掉一个不影响另一个', async () => {
    const harness = createSseFetchHarness()
    const stream = createServerHostEventStream({
      fetch: harness.fetchImpl,
      tokenEnvironment: fakeTokenEnvironment('tok-1'),
      initialReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })
    const first: ServerHostEvent[] = []
    const second: ServerHostEvent[] = []
    const unsubscribeFirst = stream.subscribe({
      onEvent: (event) => { first.push(event) },
      onStreamConnected: () => {},
    })
    const unsubscribeSecond = stream.subscribe({
      onEvent: (event) => { second.push(event) },
      onStreamConnected: () => {},
    })
    try {
      await vi.waitFor(() => { expect(harness.connections).toHaveLength(1) })
      expect(harness.calls).toHaveLength(1)

      unsubscribeFirst()
      expect(harness.calls[0]?.signal.aborted).toBe(false)
      harness.connections[0]!.push(sseFrame('mcp-stdio-close', { serverId: 'a', sessionToken: 'b', message: 'x' }))
      await vi.waitFor(() => { expect(second).toHaveLength(1) })
      expect(first).toEqual([])
    } finally {
      unsubscribeSecond()
    }
  })
})
