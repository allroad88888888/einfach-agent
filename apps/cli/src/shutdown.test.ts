// `installCliShutdown` 的时序：等多久、等不到怎么办、连按两次怎么办。
// ---------------------------------------------------------------------------
// 全部用注入的假 target，**不发真信号也不真退出**——真信号那条判据在
// `shutdownSignal.test.ts`（起真进程、发真 SIGTERM、用 pgrep 确认孙进程没了）。

import { describe, expect, it, vi } from 'vitest'
import { installCliShutdown, type ShutdownSignal, type ShutdownSignalTarget } from './shutdown'

function fakeTarget(): ShutdownSignalTarget & {
  fire: (signal: ShutdownSignal) => void
  exitCodes: number[]
  registered: ShutdownSignal[]
} {
  const handlers = new Map<ShutdownSignal, () => void>()
  const exitCodes: number[] = []
  return {
    registered: [],
    exitCodes,
    on(signal, listener) {
      handlers.set(signal, listener)
      this.registered.push(signal)
    },
    exit(code) { exitCodes.push(code) },
    fire(signal) { handlers.get(signal)?.() },
  }
}

function deferredDispose(): { dispose: () => Promise<void>; settle: () => void; calls: () => number } {
  let resolveIt = (): void => {}
  let calls = 0
  const promise = new Promise<void>((resolve) => { resolveIt = resolve })
  return {
    dispose: () => { calls += 1; return promise },
    settle: () => resolveIt(),
    calls: () => calls,
  }
}

describe('installCliShutdown', () => {
  it('三个信号都挂上；退出码是 128 + 信号号', async () => {
    const target = fakeTarget()
    installCliShutdown({ target, notice: () => {} })

    expect(target.registered).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP'])

    target.fire('SIGHUP')
    await vi.waitFor(() => expect(target.exitCodes).toEqual([129]))
  })

  it('登记进来的 dispose 跑完才退出', async () => {
    const target = fakeTarget()
    const pending = deferredDispose()
    const shutdown = installCliShutdown({ target, notice: () => {} })
    shutdown.registerHostDisposer(pending.dispose)

    target.fire('SIGTERM')
    expect(pending.calls()).toBe(1)
    await Promise.resolve()
    expect(target.exitCodes).toEqual([])

    pending.settle()
    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))
  })

  it('normal drain and signal shutdown share one idempotent pending disposal', async () => {
    const target = fakeTarget()
    const pending = deferredDispose()
    const shutdown = installCliShutdown({ target, notice: () => {} })
    shutdown.registerHostDisposer(pending.dispose)

    const normalDrain = shutdown.drain()
    target.fire('SIGTERM')
    expect(pending.calls()).toBe(1)
    expect(target.exitCodes).toEqual([])

    pending.settle()
    await normalDrain
    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))
  })

  it('normal drain propagates one failure, stays rejected, and rejects late registration', async () => {
    const shutdown = installCliShutdown({ target: fakeTarget(), notice: () => {} })
    const failure = new Error('flush failed')
    shutdown.registerHostDisposer(() => Promise.reject(failure))

    await expect(shutdown.drain()).rejects.toBe(failure)
    await expect(shutdown.drain()).rejects.toBe(failure)
    expect(() => shutdown.registerHostDisposer(async () => undefined)).toThrow('already draining')
  })

  it('signal exits after a failed drain and multiple failures remain aggregated for normal callers', async () => {
    const target = fakeTarget()
    const shutdown = installCliShutdown({ target, notice: () => {} })
    shutdown.registerHostDisposer(() => Promise.reject(new Error('one')))
    shutdown.registerHostDisposer(() => Promise.reject(new Error('two')))

    target.fire('SIGTERM')
    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))
    await expect(shutdown.drain()).rejects.toBeInstanceOf(AggregateError)
  })

  it('dispose 拖过 timeout 或抛错：都照样退出', async () => {
    const target = fakeTarget()
    const stuck = deferredDispose()
    const shutdown = installCliShutdown({ target, notice: () => {}, timeoutMs: 20 })
    shutdown.registerHostDisposer(stuck.dispose)
    shutdown.registerHostDisposer(() => Promise.reject(new Error('boom')))

    target.fire('SIGINT')
    await vi.waitFor(() => expect(target.exitCodes).toEqual([130]))

    stuck.settle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(target.exitCodes).toEqual([130])
  })

  it('第二次信号不再等待，当场退出（用户连按两次 Ctrl+C）', () => {
    const target = fakeTarget()
    const stuck = deferredDispose()
    const notices: string[] = []
    const shutdown = installCliShutdown({
      target,
      timeoutMs: 60_000,
      notice: (text) => { notices.push(text) },
    })
    shutdown.registerHostDisposer(stuck.dispose)

    target.fire('SIGINT')
    expect(target.exitCodes).toEqual([])

    target.fire('SIGINT')
    expect(target.exitCodes).toEqual([130])
    expect(notices.join('')).toContain('再次收到停止信号')
    expect(stuck.calls()).toBe(1)
  })

  it('提示写给注入的 notice；默认去处是 stderr 而不是 stdout（-p 模式下 stdout 是结果）', () => {
    const target = fakeTarget()
    const notices: string[] = []
    installCliShutdown({ target, timeoutMs: 1_234, notice: (text) => { notices.push(text) } })

    target.fire('SIGTERM')

    expect(notices[0]).toBe('正在停止（收到 SIGTERM）……最多等待 1234 毫秒收尾。\n')
  })
})
