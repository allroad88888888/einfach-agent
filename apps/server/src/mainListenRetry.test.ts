// 不在任何用例里 listen 到写死的端口号：真实网络场景用 `listen(0)` 让系统分配，
// EADDRINUSE / 非重试错误 / 耗尽三条路径用一个不碰真实网络的假 `Server` 精确控制。

import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORT_ATTEMPTS, DEFAULT_START_PORT, listenWithPortRetry } from './mainListenRetry'

describe('DEFAULT_START_PORT / DEFAULT_PORT_ATTEMPTS', () => {
  it('起始端口在非特权范围内，重试次数是正整数', () => {
    expect(DEFAULT_START_PORT).toBeGreaterThan(1024)
    expect(DEFAULT_START_PORT).toBeLessThanOrEqual(65535)
    expect(DEFAULT_PORT_ATTEMPTS).toBeGreaterThan(0)
  })
})

// ---- 假 Server：不碰真实网络，精确控制每次 listen() 的结果 ----

type FakeOutcome = { readonly code: string } | undefined

function createFakeServer(outcomeForAttempt: (attemptIndex: number) => FakeOutcome): {
  server: Server
  listenCalls: number[]
} {
  const emitter = new EventEmitter()
  const listenCalls: number[] = []
  let attemptIndex = 0

  const fake = {
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    address: () => ({ port: listenCalls[listenCalls.length - 1] ?? 0 }),
    listen(port: number, _host: string) {
      listenCalls.push(port)
      const outcome = outcomeForAttempt(attemptIndex)
      attemptIndex += 1
      queueMicrotask(() => {
        if (outcome === undefined) {
          emitter.emit('listening')
        } else {
          const error = Object.assign(new Error(outcome.code), { code: outcome.code })
          emitter.emit('error', error)
        }
      })
    },
  }

  return { server: fake as unknown as Server, listenCalls }
}

describe('listenWithPortRetry（假 Server，精确控制结果）', () => {
  it('第一次就成功：只 listen 一次，返回起始端口', async () => {
    const { server, listenCalls } = createFakeServer(() => undefined)
    const port = await listenWithPortRetry(server, { host: '127.0.0.1', startPort: 9000, attempts: 5 })
    expect(port).toBe(9000)
    expect(listenCalls).toEqual([9000])
  })

  it('前两次 EADDRINUSE，第三次成功：端口依次 +1，最终返回成功的那个', async () => {
    const { server, listenCalls } = createFakeServer((i) => (i < 2 ? { code: 'EADDRINUSE' } : undefined))
    const port = await listenWithPortRetry(server, { host: '127.0.0.1', startPort: 9000, attempts: 5 })
    expect(port).toBe(9002)
    expect(listenCalls).toEqual([9000, 9001, 9002])
  })

  it('全部 attempts 都 EADDRINUSE：耗尽后 reject，报的范围与起止端口一致', async () => {
    const { server, listenCalls } = createFakeServer(() => ({ code: 'EADDRINUSE' }))
    await expect(listenWithPortRetry(server, { host: '127.0.0.1', startPort: 9000, attempts: 3 })).rejects.toThrow(
      '端口 9000-9002 均已被占用',
    )
    expect(listenCalls).toEqual([9000, 9001, 9002])
  })

  it('非 EADDRINUSE 的错误（如 EACCES）不重试，第一次就直接抛出', async () => {
    const { server, listenCalls } = createFakeServer(() => ({ code: 'EACCES' }))
    await expect(listenWithPortRetry(server, { host: '127.0.0.1', startPort: 80, attempts: 5 })).rejects.toMatchObject({
      code: 'EACCES',
    })
    expect(listenCalls).toEqual([80])
  })

  it('attempts 不传时落到 DEFAULT_PORT_ATTEMPTS', async () => {
    const { server, listenCalls } = createFakeServer((i) => (i < DEFAULT_PORT_ATTEMPTS - 1 ? { code: 'EADDRINUSE' } : undefined))
    const port = await listenWithPortRetry(server, { host: '127.0.0.1', startPort: 9000 })
    expect(port).toBe(9000 + DEFAULT_PORT_ATTEMPTS - 1)
    expect(listenCalls).toHaveLength(DEFAULT_PORT_ATTEMPTS)
  })
})

// ---- 真实网络：证明对着真正的 http.Server / 真正的 EADDRINUSE 也成立 ----

describe('listenWithPortRetry（真实 http.Server，端口均由系统分配，不写死任何号）', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      if (cleanup) await cleanup()
    }
  })

  async function listenBlocker(): Promise<number> {
    const blocker = createServer((_req, res) => res.end('blocker'))
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    cleanups.push(async () => {
      blocker.close()
      await once(blocker, 'close')
    })
    return (blocker.address() as AddressInfo).port
  }

  it('目标端口已被占用时换到另一个端口，且新端口真的在监听', async () => {
    const occupiedPort = await listenBlocker()
    const target = createServer((_req, res) => res.end('target'))
    cleanups.push(async () => {
      target.close()
      await once(target, 'close')
    })

    const boundPort = await listenWithPortRetry(target, { host: '127.0.0.1', startPort: occupiedPort, attempts: 10 })

    expect(boundPort).not.toBe(occupiedPort)
    expect((target.address() as AddressInfo).port).toBe(boundPort)
  })

  it('传 0 走系统分配，第一次就成功', async () => {
    const target = createServer((_req, res) => res.end('target'))
    cleanups.push(async () => {
      target.close()
      await once(target, 'close')
    })
    const boundPort = await listenWithPortRetry(target, { host: '127.0.0.1', startPort: 0, attempts: 1 })
    expect(boundPort).toBeGreaterThan(0)
  })
})
