// `installHostShutdown` 的时序：等多久、等不到怎么办、连按两次怎么办。
// ---------------------------------------------------------------------------
// 这里全部用注入的假 target，**不发真信号也不真退出**——真信号那条判据在
// `mainShutdownSignal.test.ts`（起真进程、发真 SIGTERM、用 pgrep 确认孙进程没了）。
// 两条测试证的是不同的事：这里证"时序逻辑对"，那里证"这套时序真的接在了宿主的信号上"。

import { describe, expect, it, vi } from 'vitest'
import { installHostShutdown, type ShutdownSignal, type ShutdownSignalTarget } from './mainShutdown'

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

/** 一个可以从外面决定何时 resolve 的 dispose。 */
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

describe('installHostShutdown', () => {
  it('三个信号都挂上；退出码是 128 + 信号号', async () => {
    const target = fakeTarget()
    installHostShutdown({ target, notice: () => {} })

    expect(target.registered).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP'])

    target.fire('SIGINT')
    await vi.waitFor(() => expect(target.exitCodes).toEqual([130]))
  })

  it('登记进来的 dispose 全部跑完才退出，多个 dispose 是并发的', async () => {
    const target = fakeTarget()
    const first = deferredDispose()
    const second = deferredDispose()
    const shutdown = installHostShutdown({ target, notice: () => {} })
    shutdown.registerHostDisposer(first.dispose)
    shutdown.registerHostDisposer(second.dispose)

    target.fire('SIGTERM')

    // 两个 dispose 立刻都被调用（并发），但都没结束，所以还不能退出。
    expect(first.calls()).toBe(1)
    expect(second.calls()).toBe(1)
    await Promise.resolve()
    expect(target.exitCodes).toEqual([])

    first.settle()
    second.settle()
    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))
  })

  it('dispose 拖过 timeout：照样退出（兜底是 host-node 的 exit 回调，不是继续等）', async () => {
    const target = fakeTarget()
    const stuck = deferredDispose()
    const shutdown = installHostShutdown({ target, notice: () => {}, timeoutMs: 20 })
    shutdown.registerHostDisposer(stuck.dispose)

    target.fire('SIGTERM')
    expect(target.exitCodes).toEqual([])

    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))

    // 迟到的 dispose 不该再触发第二次退出。
    stuck.settle()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(target.exitCodes).toEqual([143])
  })

  it('dispose 抛错不拖住其余的，也不阻止退出', async () => {
    const target = fakeTarget()
    const good = deferredDispose()
    const shutdown = installHostShutdown({ target, notice: () => {}, timeoutMs: 10_000 })
    shutdown.registerHostDisposer(() => Promise.reject(new Error('boom')))
    shutdown.registerHostDisposer(() => { throw new Error('同步抛') })
    shutdown.registerHostDisposer(good.dispose)

    target.fire('SIGTERM')
    good.settle()

    await vi.waitFor(() => expect(target.exitCodes).toEqual([143]))
  })

  it('第二次信号不再等待，当场退出（用户连按两次 Ctrl+C）', async () => {
    const target = fakeTarget()
    const stuck = deferredDispose()
    const notices: string[] = []
    const shutdown = installHostShutdown({
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
    // 第二次信号没有再调一次 dispose——它已经在跑了。
    expect(stuck.calls()).toBe(1)
  })

  it('提示文案写给注入的 notice，不直接写 stdout', () => {
    const target = fakeTarget()
    const notices: string[] = []
    installHostShutdown({ target, timeoutMs: 1_234, notice: (text) => { notices.push(text) } })

    target.fire('SIGHUP')

    expect(notices[0]).toBe('正在停止（收到 SIGHUP）……最多等待 1234 毫秒收尾。\n')
  })
})
