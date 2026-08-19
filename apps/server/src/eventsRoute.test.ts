// 连接本身：这条路由怎么应答一次请求，以及连上之后它自己会往线上写什么。
// 「事件订阅关系」那一半在 `eventsRouteSubscription.test.ts`，值的保真在 `eventsRouteParity.test.ts`。

import { describe, expect, it } from 'vitest'
import { createHostEventBus } from '@web-agent/host-node'
import { EVENTS_ROUTE_PATH } from './eventsRoute'
import { openSseClient, withEventsRouteServer } from './eventsRoute.testHarness'

/** 用例只关心传输，不关心谁在报错——handler 出错会被各用例自己收。 */
function quietBus(): ReturnType<typeof createHostEventBus> {
  return createHostEventBus({ onHandlerError: () => {} })
}

describe('createEventsRouteHandler：方法与路径', () => {
  it('GET 之外一律 405，并带 allow: GET', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
        const client = await openSseClient(server.port, { method })
        await client.ended
        expect(client.status, method).toBe(405)
        expect(client.headers.allow, method).toBe('GET')
      }
    })
  })

  it('405 的正文是 API 面统一的失败信封', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port, { method: 'POST' })
      await client.ended
      expect(JSON.parse(client.raw())).toEqual({
        error: 'method_not_allowed',
        message: '事件流只接受 GET 请求。',
      })
    })
  })

  it('路径只精确匹配 /api/events，多一截少一截都不归本模块', async () => {
    // 前缀匹配会让打错的路径拿到一条正常的事件流——静默地正确。这里钉住它们落到 404
    // （脚手架里 `isEventsRoutePath` 为假就回 404，与 `handleApi` 的 `unknown_endpoint` 同位）。
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      for (const path of ['/api/events/', '/api/events/foo', '/api/eventsX', '/api/event']) {
        const client = await openSseClient(server.port, { path })
        await client.ended
        expect(client.status, path).toBe(404)
      }
      const ok = await openSseClient(server.port, { path: EVENTS_ROUTE_PATH })
      expect(ok.status).toBe(200)
      ok.disconnect()
    })
  })
})

describe('createEventsRouteHandler：响应头与握手', () => {
  it('GET 拿到 200、text/event-stream，且没有 content-length', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      expect(client.status).toBe(200)
      expect(client.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(client.headers['cache-control']).toBe('no-store')
      expect(client.headers['x-content-type-options']).toBe('nosniff')
      // 流的长度在结束前不知道，给不出来；有 content-length 反而会让收端在读满后停下。
      expect(client.headers['content-length']).toBeUndefined()
      client.disconnect()
    })
  })

  it('连上就先收到一条 connected 注释行，不是事件', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      expect(await client.waitForComment(0)).toBe('connected')
      expect(client.events).toEqual([])
      client.disconnect()
    })
  })
})

describe('createEventsRouteHandler：心跳', () => {
  it('空闲连接上按间隔发注释行，不产生事件', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 10 }, async (server) => {
      const client = await openSseClient(server.port)
      expect(await client.waitForComment(0)).toBe('connected')
      expect(await client.waitForComment(1)).toBe('heartbeat')
      expect(await client.waitForComment(2)).toBe('heartbeat')
      expect(client.events).toEqual([])
      client.disconnect()
    })
  })

  it('heartbeatIntervalMs 为 0 时不发心跳', async () => {
    await withEventsRouteServer({ events: quietBus(), heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      expect(client.comments).toEqual(['connected'])
      client.disconnect()
    })
  })

  it('断开之后心跳不再产生任何错误报告', async () => {
    // **这条用例证明不了「定时器被 clearInterval 掉了」**：心跳定时器是 unref 的，一个漏掉的
    // 定时器在这里只是空转一下就被 `open === false` 挡住，测不出来。定时器真被清掉那一条在
    // `eventsRouteStream.test.ts` 用假定时器的 `vi.getTimerCount()` 钉。这里钉的是另一件事：
    // 客户端走了之后，心跳不会变成一串刷在日志里的「写失败」。
    const reported: unknown[] = []
    const bus = createHostEventBus({ onHandlerError: (error) => { reported.push(error) } })
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 5 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(1)
      client.disconnect()
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      expect(reported).toEqual([])
    })
  })
})
