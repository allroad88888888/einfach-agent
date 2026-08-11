import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MCP_KEEPALIVE_POLICY,
  McpKeepaliveMonitor,
  type McpKeepaliveHost,
} from './keepaliveMonitor'
import type { McpCallToolResult, McpConnection, McpOperationOptions, McpRemoteTool } from './types'

/**
 * 保活探活【自身的时间语义】：多久探一次、探多久算超时、连续几次不通判死。
 * 连接身份与判死之后怎么办不在这里 —— 那是 clientManager 的事，见
 * clientManager.keepalive.test.ts。
 */

const POLICY = { intervalMs: 1_000, timeoutMs: 100, failureThreshold: 2 }

/** 只有 ping 有意义的连接替身：monitor 从头到尾不该碰其余任何能力。 */
class ProbeConnection implements McpConnection {
  pingCount = 0
  abortCount = 0
  /** 设成 Error 后每次探活都以它失败。 */
  failure: Error | undefined
  /** true 时探活不自行结算，只能被超时或取消掐断。 */
  hang = false
  ping?: (options?: McpOperationOptions) => Promise<void>

  constructor(options: { supportsPing?: boolean } = {}) {
    if (options.supportsPing !== false) {
      this.ping = (probeOptions) => this.runPing(probeOptions)
    }
  }

  async listTools(): Promise<readonly McpRemoteTool[]> {
    throw new Error('保活探活不该调用 listTools')
  }

  async callTool(): Promise<McpCallToolResult> {
    throw new Error('保活探活不该调用 callTool')
  }

  onToolsChanged(): () => void {
    return () => undefined
  }

  onClose(): () => void {
    return () => undefined
  }

  async close(): Promise<void> {}

  private runPing(options?: McpOperationOptions): Promise<void> {
    this.pingCount += 1
    if (this.failure) return Promise.reject(this.failure)
    if (!this.hang) return Promise.resolve()
    return new Promise<void>((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        this.abortCount += 1
        reject(new Error('探活已取消'))
      })
    })
  }
}

function setup() {
  const serving = new Map<string, McpConnection>()
  const dead: Array<{ serverId: string; connection: McpConnection; error: Error }> = []
  const host: McpKeepaliveHost = {
    isServing: (serverId, connection) => serving.get(serverId) === connection,
    onDead: (serverId, connection, error) => {
      dead.push({ serverId, connection, error })
    },
  }
  const monitor = new McpKeepaliveMonitor(host, POLICY)
  const connection = new ProbeConnection()

  const serve = (target: McpConnection = connection) => {
    serving.set('remote', target)
    monitor.start('remote', target)
  }

  return { serving, dead, monitor, connection, serve }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe('McpKeepaliveMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('默认口径是 30 秒探一次、10 秒超时、连续 2 次不通判死', () => {
    expect(DEFAULT_MCP_KEEPALIVE_POLICY).toEqual({
      intervalMs: 30_000,
      timeoutMs: 10_000,
      failureThreshold: 2,
    })
  })

  it('周期性探活，成功一次就把连续失败计数清零', async () => {
    const { monitor, connection, dead, serve } = setup()
    serve()
    expect(monitor.pending('remote')).toBe(true)

    await advance(999)
    expect(connection.pingCount).toBe(0)
    await advance(1)
    expect(connection.pingCount).toBe(1)

    connection.failure = new Error('socket hung up')
    await advance(1_000)
    expect(connection.pingCount).toBe(2)
    expect(monitor.failures('remote')).toBe(1)

    connection.failure = undefined
    await advance(1_000)
    expect(connection.pingCount).toBe(3)
    expect(monitor.failures('remote')).toBe(0)
    expect(dead).toEqual([])
    // 每次探活结束都恰好排下一次，不堆积。
    expect(vi.getTimerCount()).toBe(1)
  })

  it('连续不通到阈值才判死，并把最后一次的原始错误原样上交', async () => {
    const { monitor, connection, dead, serve } = setup()
    serve()
    connection.failure = new Error('first')

    await advance(1_000)
    expect(dead).toEqual([])
    expect(monitor.failures('remote')).toBe(1)

    const last = new Error('socket hung up')
    connection.failure = last
    await advance(1_000)

    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ serverId: 'remote', connection })
    // 原样：不包装成新的 Error，失败分类才继续认得出这条消息是谁写的。
    expect(dead[0]?.error).toBe(last)
    // 判死之后表已撤掉，不再有任何定时器。
    expect(vi.getTimerCount()).toBe(0)
    expect(monitor.pending('remote')).toBe(false)

    await advance(10_000)
    expect(connection.pingCount).toBe(2)
    expect(dead).toHaveLength(1)
  })

  it('探活超时算一次不通，并掐掉那次在飞的探活', async () => {
    const { connection, dead, monitor, serve } = setup()
    serve()
    connection.hang = true

    await advance(1_000)
    expect(connection.pingCount).toBe(1)
    // 探活在飞：此刻挂着的是超时定时器，不是下一次探活。
    expect(vi.getTimerCount()).toBe(1)
    expect(monitor.pending('remote')).toBe(false)

    await advance(99)
    expect(monitor.failures('remote')).toBe(0)
    await advance(1)
    expect(connection.abortCount).toBe(1)
    expect(monitor.failures('remote')).toBe(1)
    expect(dead).toEqual([])

    await advance(1_000 + 100)
    expect(connection.pingCount).toBe(2)
    expect(dead).toHaveLength(1)
    expect(dead[0]?.error.message).toContain('保活探测超时')
    expect(dead[0]?.error.message).toContain('100 毫秒')
  })

  it('不实现 ping 的连接不起表', async () => {
    const { monitor, dead, serve } = setup()
    const legacy = new ProbeConnection({ supportsPing: false })
    serve(legacy)

    expect(monitor.pending('remote')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await advance(100_000)
    expect(legacy.pingCount).toBe(0)
    expect(dead).toEqual([])
  })

  it('连接不再服役就自行收摊：不再探活，也不判死', async () => {
    const { serving, monitor, connection, dead, serve } = setup()
    serve()

    await advance(1_000)
    expect(connection.pingCount).toBe(1)

    // 宿主那边已经换代/断开，但没人来停表（例如一次迟到的路径）。
    serving.delete('remote')
    connection.failure = new Error('late failure')
    await advance(1_000)

    expect(connection.pingCount).toBe(1)
    expect(dead).toEqual([])
    expect(monitor.pending('remote')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('探活在飞时 stop()：定时器清干净，落地结果不再计数', async () => {
    const { monitor, connection, dead, serve } = setup()
    serve()
    connection.hang = true

    await advance(1_000)
    expect(vi.getTimerCount()).toBe(1)

    monitor.stop('remote')
    await advance(0)

    expect(connection.abortCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(monitor.failures('remote')).toBe(0)
    expect(dead).toEqual([])

    await advance(100_000)
    expect(connection.pingCount).toBe(1)
  })

  it('起新表时上一世代在飞的探活既不计数也不判死', async () => {
    const { serving, monitor, connection, dead, serve } = setup()
    serve()
    connection.hang = true
    await advance(1_000)
    expect(connection.pingCount).toBe(1)

    // 换代：旧连接退役，新连接起表。
    const fresh = new ProbeConnection()
    serving.set('remote', fresh)
    monitor.start('remote', fresh)
    await advance(0)

    expect(connection.abortCount).toBe(1)
    expect(dead).toEqual([])
    expect(monitor.failures('remote')).toBe(0)

    await advance(1_000)
    expect(fresh.pingCount).toBe(1)
    expect(connection.pingCount).toBe(1)
    expect(monitor.failures('remote')).toBe(0)
  })
})
