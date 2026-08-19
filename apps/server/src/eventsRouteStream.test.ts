// 用假的 `ServerResponse` 测「收账」那一半。
// ---------------------------------------------------------------------------
// 与 `eventsRouteSubscription.test.ts` 分工不同，两边都必要：
//   · 那边起真 server、走真 socket，证明的是**断开时 Node 真的会触发 `'close'`**——这一点假对象
//     永远证明不了，而它正是漏退订泄漏的唯一防线。
//   · 这边用假对象 + 假定时器，证明的是**收到 `'close'` 之后账收干净了**：心跳定时器被
//     `clearInterval` 掉、订阅退光、重复触发幂等。这几条在真 socket 上不可观测——心跳定时器是
//     `unref()` 的，`process.getActiveResourcesInfo()` 按设计看不见它（已实测），于是「忘了
//     clearInterval」在真 server 的用例里是**绿的**。假定时器的 `vi.getTimerCount()` 能看见。
//
// 还有三条只能在这里造出来的边界：连接在 handler 跑到之前就已经死了、`write` 抛异常、
// 响应发 `'error'` 而不是 `'close'`。

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostEventBus, HOST_EVENT_NAMES } from '@einfach-agent/host-node'
import { createCountingSource } from './eventsRoute.testHarness'
import { openEventStream } from './eventsRouteStream'

class FakeResponse extends EventEmitter {
  statusCode = 0
  writableEnded = false
  destroyed = false
  readonly headers: Record<string, unknown> = {}
  readonly chunks: string[] = []
  /** 置上之后 `write` 抛异常，模拟 EPIPE / ERR_STREAM_DESTROYED。 */
  failWrites = false

  setHeader(name: string, value: unknown): void { this.headers[name] = value }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('ERR_STREAM_DESTROYED')
    this.chunks.push(chunk)
    return true
  }

  asResponse(): ServerResponse { return this as unknown as ServerResponse }
}

const fakeRequest = { socket: { setNoDelay: () => {} } } as unknown as IncomingMessage

afterEach(() => { vi.useRealTimers() })

describe('openEventStream：断开时收账', () => {
  it('close 事件到达时心跳定时器被清掉', () => {
    vi.useFakeTimers()
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), {
      events: createHostEventBus({ onHandlerError: () => {} }),
      heartbeatIntervalMs: 1000,
    })
    expect(vi.getTimerCount()).toBe(1)
    response.emit('close')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close 事件到达时订阅退光', () => {
    const counting = createCountingSource(createHostEventBus({ onHandlerError: () => {} }))
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 0 })
    expect(counting.active()).toBe(HOST_EVENT_NAMES.length)
    response.emit('close')
    expect(counting.active()).toBe(0)
  })

  it('响应发 error 而不是 close 时同样收账', () => {
    const counting = createCountingSource(createHostEventBus({ onHandlerError: () => {} }))
    const response = new FakeResponse()
    // 没有这条 'error' 监听，一个响应流上的错误会变成未捕获异常把进程带走。
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 0 })
    response.emit('error', new Error('boom'))
    expect(counting.active()).toBe(0)
  })

  it('close 重复触发是幂等的', () => {
    const counting = createCountingSource(createHostEventBus({ onHandlerError: () => {} }))
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 0 })
    response.emit('close')
    response.emit('close')
    response.emit('error', new Error('boom'))
    expect(counting.active()).toBe(0)
  })

  it('handler 被调到时连接已经死了：一条订阅都不挂', () => {
    // 真实竞态：客户端在请求被分派到之前就断了，`'close'` 已经发射过，之后挂的监听器收不到。
    // 这一步复查（`response.destroyed`）就是那个竞态的兜底；少了它就是每次都泄漏一组 handler。
    const counting = createCountingSource(createHostEventBus({ onHandlerError: () => {} }))
    const response = new FakeResponse()
    response.destroyed = true
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 1000 })
    expect(counting.active()).toBe(0)
    expect(response.chunks).toEqual([])
  })

  it('write 抛异常时按断开处理：退订、清定时器、不向上抛', () => {
    vi.useFakeTimers()
    const bus = createHostEventBus({ onHandlerError: () => {} })
    const counting = createCountingSource(bus)
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 1000 })
    expect(counting.active()).toBe(HOST_EVENT_NAMES.length)

    response.failWrites = true
    expect(() => {
      bus.emitHostEvent('mcp-stdio-close', { serverId: 's', sessionToken: 't', message: 'm' })
    }).not.toThrow()
    expect(counting.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writableEnded 之后不再写，并就地收账', () => {
    const bus = createHostEventBus({ onHandlerError: () => {} })
    const counting = createCountingSource(bus)
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), { events: counting.source, heartbeatIntervalMs: 0 })
    const before = response.chunks.length
    response.writableEnded = true
    bus.emitHostEvent('mcp-stdio-close', { serverId: 's', sessionToken: 't', message: 'm' })
    expect(response.chunks).toHaveLength(before)
    expect(counting.active()).toBe(0)
  })
})

describe('openEventStream：响应头与心跳节奏', () => {
  it('先出头部再出第一条注释行', () => {
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), {
      events: createHostEventBus({ onHandlerError: () => {} }),
      heartbeatIntervalMs: 0,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(response.headers['content-length']).toBeUndefined()
    expect(response.chunks).toEqual([': connected\n'])
  })

  it('心跳按间隔重复发，且发的是注释行', () => {
    vi.useFakeTimers()
    const response = new FakeResponse()
    openEventStream(fakeRequest, response.asResponse(), {
      events: createHostEventBus({ onHandlerError: () => {} }),
      heartbeatIntervalMs: 1000,
    })
    vi.advanceTimersByTime(3000)
    expect(response.chunks).toEqual([': connected\n', ': heartbeat\n', ': heartbeat\n', ': heartbeat\n'])
  })

  it('心跳间隔为负数或非有限值时不装定时器', () => {
    vi.useFakeTimers()
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = new FakeResponse()
      openEventStream(fakeRequest, response.asResponse(), {
        events: createHostEventBus({ onHandlerError: () => {} }),
        heartbeatIntervalMs: interval,
      })
      expect(vi.getTimerCount(), String(interval)).toBe(0)
      response.emit('close')
    }
  })
})
