import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MCP_RECONNECT_POLICY,
  McpReconnectScheduler,
  mcpReconnectDelayMs,
  mcpReconnectExhaustedMessage,
  type McpReconnectAttempt,
} from './reconnectSchedule'

describe('mcpReconnectDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    const delays = Array.from({ length: 8 }, (_, index) => mcpReconnectDelayMs(index))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })

  it('clamps out-of-range attempt indexes instead of producing NaN/Infinity', () => {
    expect(mcpReconnectDelayMs(-5)).toBe(1_000)
    expect(mcpReconnectDelayMs(1.9)).toBe(2_000)
    expect(mcpReconnectDelayMs(4_096)).toBe(30_000)
  })
})

describe('McpReconnectScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs each attempt only after its backoff and reports the attempt number', () => {
    const scheduler = new McpReconnectScheduler()
    const seen: McpReconnectAttempt[] = []
    const run = (attempt: McpReconnectAttempt) => {
      seen.push(attempt)
    }

    expect(scheduler.schedule('alpha', run)).toEqual({
      scheduled: true,
      attempt: 1,
      delayMs: 1_000,
    })
    expect(scheduler.pending('alpha')).toBe(true)
    vi.advanceTimersByTime(999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([{ attempt: 1, delayMs: 1_000, remaining: 5 }])
    expect(scheduler.pending('alpha')).toBe(false)
    expect(scheduler.attempts('alpha')).toBe(1)

    expect(scheduler.schedule('alpha', run)).toMatchObject({ attempt: 2, delayMs: 2_000 })
    vi.advanceTimersByTime(2_000)
    expect(seen.at(-1)).toEqual({ attempt: 2, delayMs: 2_000, remaining: 4 })
  })

  it('keeps per-server budgets independent', () => {
    const scheduler = new McpReconnectScheduler()
    scheduler.schedule('alpha', () => {})
    vi.advanceTimersByTime(1_000)
    scheduler.schedule('alpha', () => {})

    expect(scheduler.schedule('beta', () => {})).toMatchObject({ delayMs: 1_000 })
    expect(scheduler.attempts('alpha')).toBe(1)
    expect(scheduler.attempts('beta')).toBe(0)
  })

  it('refuses to schedule once the budget is spent', () => {
    const scheduler = new McpReconnectScheduler({ maxAttempts: 3 })
    for (let index = 0; index < 3; index += 1) {
      expect(scheduler.schedule('alpha', () => {}).scheduled).toBe(true)
      vi.advanceTimersByTime(30_000)
    }

    expect(scheduler.schedule('alpha', () => {})).toEqual({ scheduled: false, attempts: 3 })
    expect(scheduler.pending('alpha')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel clears the pending timer and gives the budget back', () => {
    const scheduler = new McpReconnectScheduler()
    const run = vi.fn()
    scheduler.schedule('alpha', run)
    vi.advanceTimersByTime(1_000)
    expect(run).toHaveBeenCalledTimes(1)

    scheduler.schedule('alpha', run)
    expect(scheduler.cancel('alpha')).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // 预算被清零：下一条链重新从 1s 起步。
    expect(scheduler.schedule('alpha', run)).toMatchObject({ attempt: 1, delayMs: 1_000 })
    expect(scheduler.cancel('beta')).toBe(false)
  })

  it('replaces a pending timer without spending an extra attempt', () => {
    const scheduler = new McpReconnectScheduler()
    const run = vi.fn()
    scheduler.schedule('alpha', run)
    vi.advanceTimersByTime(500)
    expect(scheduler.schedule('alpha', run)).toMatchObject({ attempt: 1, delayMs: 1_000 })

    vi.advanceTimersByTime(500)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defaults to six attempts spanning about a minute', () => {
    expect(DEFAULT_MCP_RECONNECT_POLICY.maxAttempts).toBe(6)
    const total = Array.from(
      { length: DEFAULT_MCP_RECONNECT_POLICY.maxAttempts },
      (_, index) => mcpReconnectDelayMs(index),
    ).reduce((sum, delay) => sum + delay, 0)
    expect(total).toBe(61_000)
  })
})

describe('mcpReconnectExhaustedMessage', () => {
  it('says retrying stopped and keeps the last failure, truncated', () => {
    expect(mcpReconnectExhaustedMessage(6, 'connect refused')).toBe(
      '连接反复失败，需要人工介入：已自动重连 6 次仍未成功，已停止重试。最后一次失败：connect refused',
    )
    expect(mcpReconnectExhaustedMessage(6, 'x'.repeat(5_000))).toHaveLength(
      '连接反复失败，需要人工介入：已自动重连 6 次仍未成功，已停止重试。最后一次失败：'.length + 2_000,
    )
  })
})
