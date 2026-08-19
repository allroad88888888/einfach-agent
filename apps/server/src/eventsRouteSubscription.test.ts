// 订阅关系：一条连接与宿主事件汇之间的绑定——事件怎么送到、以及**断开时怎么解绑**。
//
// 「解绑」是本卡判据点名的那一条，也是这里的重头：漏了就是每开一次页面泄漏一组 handler，
// 而症状（内存缓慢增长、一条事件在服务端被处理 N 遍）离病因极远。判定量是
// `createCountingSource` 记的活跃订阅数——它是这件事在外部唯一可观测的形态。

import { describe, expect, it } from 'vitest'
import { createHostEventBus, HOST_EVENT_NAMES, type NodeHostInvokeOptions } from '@web-agent/host-node'
import {
  createCountingSource,
  openSseClient,
  startEventsRouteTestServer,
  waitForCondition,
  withEventsRouteServer,
} from './eventsRoute.testHarness'

const CLOSE_PAYLOAD = { serverId: 'srv-1', sessionToken: 'tok-1', message: 'MCP 子进程已退出。' }

function quietBus(): ReturnType<typeof createHostEventBus> {
  return createHostEventBus({ onHandlerError: () => {} })
}

describe('事件投递', () => {
  it('进程内 emit 的事件出现在 SSE 上', async () => {
    const bus = quietBus()
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      bus.emitHostEvent('mcp-stdio-close', CLOSE_PAYLOAD)
      const event = await client.waitForEvent(0)
      expect(event.event).toBe('mcp-stdio-close')
      expect(JSON.parse(event.data)).toEqual(CLOSE_PAYLOAD)
      client.disconnect()
    })
  })

  it('两个事件名都转发，且 event 字段就是事件名', async () => {
    // 端点遍历 `HOST_EVENT_NAMES` 订阅而不是手写名字，所以这条同时是「全集里的每一个都通」。
    const bus = quietBus()
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      bus.emitHostEvent('mcp-stdio-tools-changed', { serverId: 'a', sessionToken: 'b' })
      bus.emitHostEvent('mcp-stdio-close', CLOSE_PAYLOAD)
      await client.waitForEvent(1)
      expect(client.events.map((event) => event.event)).toEqual([...HOST_EVENT_NAMES])
      client.disconnect()
    })
  })

  it('多个客户端各收到一份（全局广播，不按 serverId 路由）', async () => {
    const bus = quietBus()
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 0 }, async (server) => {
      const first = await openSseClient(server.port)
      const second = await openSseClient(server.port)
      await first.waitForComment(0)
      await second.waitForComment(0)
      bus.emitHostEvent('mcp-stdio-close', CLOSE_PAYLOAD)
      expect(JSON.parse((await first.waitForEvent(0)).data)).toEqual(CLOSE_PAYLOAD)
      expect(JSON.parse((await second.waitForEvent(0)).data)).toEqual(CLOSE_PAYLOAD)
      first.disconnect()
      second.disconnect()
    })
  })

  it('接线要写的那一行适配（C1 的 { name, payload } → C2 的 (name, payload)）真的通', async () => {
    // `createServer.ts` 装配时，MCP 传输层拿到的是**发射面的适配**、事件流拿到的是**订阅面**，
    // 中间靠这一行把两种形状对上。它写在本卡的交回报告里，所以在这里连编译带行为一起钉住——
    // 主会话粘过去的那一行若形状不对，这条用例先红，而不是等到 MCP 掉线时前端没反应。
    type HostEventEmitterSlot = NonNullable<NodeHostInvokeOptions['emitHostEvent']>
    const bus = quietBus()
    const emitHostEvent: HostEventEmitterSlot = (event) => {
      bus.emitHostEvent(event.name, event.payload)
    }
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      emitHostEvent({ name: 'mcp-stdio-close', payload: CLOSE_PAYLOAD })
      const event = await client.waitForEvent(0)
      expect(event.event).toBe('mcp-stdio-close')
      expect(JSON.parse(event.data)).toEqual(CLOSE_PAYLOAD)
      client.disconnect()
    })
  })

  it('事件顺序按 emit 顺序', async () => {
    const bus = quietBus()
    await withEventsRouteServer({ events: bus, heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      for (let index = 0; index < 5; index += 1) {
        bus.emitHostEvent('mcp-stdio-tools-changed', { serverId: `s-${index}`, sessionToken: 't' })
      }
      await client.waitForEvent(4)
      expect(client.events.map((event) => JSON.parse(event.data).serverId as string))
        .toEqual(['s-0', 's-1', 's-2', 's-3', 's-4'])
      client.disconnect()
    })
  })
})

describe('断开即退订', () => {
  it('连接建立后每个事件名各挂一条订阅，断开后一条不剩', async () => {
    const counting = createCountingSource(quietBus())
    await withEventsRouteServer({ events: counting.source, heartbeatIntervalMs: 0 }, async (server) => {
      expect(counting.active()).toBe(0)
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      expect(counting.active()).toBe(HOST_EVENT_NAMES.length)

      // 这一步等价于「用户关掉了标签页」。
      client.disconnect()
      await waitForCondition(() => counting.active() === 0, '服务端退订全部宿主事件订阅')
    })
  })

  it('N 条连接开开关关之后订阅数回到 0（不是每开一次泄漏一组）', async () => {
    const counting = createCountingSource(quietBus())
    await withEventsRouteServer({ events: counting.source, heartbeatIntervalMs: 0 }, async (server) => {
      for (let round = 0; round < 4; round += 1) {
        const client = await openSseClient(server.port)
        await client.waitForComment(0)
        client.disconnect()
        await waitForCondition(() => counting.active() === 0, `第 ${round + 1} 轮退订`)
      }
      expect(counting.active()).toBe(0)
    })
  })

  it('只断开其中一条连接，另一条照常收事件', async () => {
    const bus = quietBus()
    const counting = createCountingSource(bus)
    await withEventsRouteServer({ events: counting.source, heartbeatIntervalMs: 0 }, async (server) => {
      const doomed = await openSseClient(server.port)
      const survivor = await openSseClient(server.port)
      await doomed.waitForComment(0)
      await survivor.waitForComment(0)
      expect(counting.active()).toBe(HOST_EVENT_NAMES.length * 2)

      doomed.disconnect()
      await waitForCondition(
        () => counting.active() === HOST_EVENT_NAMES.length,
        '只退掉断开那条连接的订阅',
      )

      bus.emitHostEvent('mcp-stdio-close', CLOSE_PAYLOAD)
      expect(JSON.parse((await survivor.waitForEvent(0)).data)).toEqual(CLOSE_PAYLOAD)
      expect(doomed.events).toEqual([])
      survivor.disconnect()
    })
  })

  it('断开之后再 emit：不报错、不再有 handler 被调到', async () => {
    // 漏退订的最直接症状就是这里——往一个死掉的 response 上写，且错误会绕道 C2 的
    // onHandlerError 变成一条来路不明的日志。
    const reported: unknown[] = []
    const bus = createHostEventBus({ onHandlerError: (error) => { reported.push(error) } })
    const counting = createCountingSource(bus)
    await withEventsRouteServer({ events: counting.source, heartbeatIntervalMs: 0 }, async (server) => {
      const client = await openSseClient(server.port)
      await client.waitForComment(0)
      client.disconnect()
      await waitForCondition(() => counting.active() === 0, '退订')

      expect(() => { bus.emitHostEvent('mcp-stdio-close', CLOSE_PAYLOAD) }).not.toThrow()
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(reported).toEqual([])
    })
  })

  it('server 关掉时连接被收干净，客户端的流结束', async () => {
    const counting = createCountingSource(quietBus())
    const server = await startEventsRouteTestServer({ events: counting.source, heartbeatIntervalMs: 0 })
    const client = await openSseClient(server.port)
    await client.waitForComment(0)
    await server.close()
    await client.ended
    await waitForCondition(() => counting.active() === 0, '服务端关闭后退订')
  })
})
