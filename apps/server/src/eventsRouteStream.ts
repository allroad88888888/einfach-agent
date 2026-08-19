// 一条 SSE 连接的生命周期：订阅、写帧、心跳、**断开即退订**。
// ---------------------------------------------------------------------------
// 本文件只负责「一个 `ServerResponse` 变成一条活的事件流，并在它死的时候把账收干净」。
// 帧长什么样在 `eventsRouteFrame.ts`，路由与认证在 `eventsRoute.ts` / `authGuard.ts`。
//
// ═══ 【最要紧的一条】断开必须退订 ═══
//
// 浏览器关标签页 / 刷新 / 客户端 abort → socket 断 → `response` 触发 `'close'` → 调 C2 返回的
// 取消函数。**漏掉这一步的后果与症状离得极远**：每开一次页面就永久多留一组 handler，它们仍然
// 会被每一次 `emitHostEvent` 调到、仍然会去 `response.write` 一个死掉的响应。表现是内存缓慢增长、
// 一条 MCP close 事件在服务端被处理 N 遍，而这两样都不会指向「上周那次刷新没退订」。
// 所以：`'close'` 与 `'error'` 都挂上同一个幂等的 `closeStream`，且**在写任何字节之前就挂**——
// 客户端有可能在 handler 跑到这里之前就已经断了，那时 `'close'` 早已发射过，后挂的监听器
// 永远不会被调用。挂完立刻复查一次 `response.destroyed`，这一次复查就是那个竞态的兜底。
// `eventsRoute.test.ts` 用一个会数活跃订阅数的假 `HostEventSource` 正面钉住这条。
//
// ═══ 心跳：发，间隔 15 秒，用注释行 ═══
//
// 【为什么必须发】本端点的两个事件都是 MCP 子进程的生命周期通知——**低频到可以数小时一条都没有**。
// 一条几小时不产生任何字节的连接，会被路径上任何一个有空闲超时的东西掐掉：浏览器自身的连接管理、
// 操作系统/NAT 的空闲回收、以及用户可能自己套在前面的反向代理。TCP 自带的 keepalive 默认两小时
// 起步，指望不上。
// 而**掐掉之后的症状恰好是最坏的那种**：服务端这边 socket 死了会触发 `'close'`（我们会退订，
// 状态是干净的），客户端那边却可能只是「再也收不到东西」——它不知道自己已经聋了，于是
// 「MCP 退出了但前端没反应」，既不报错也不指向病因。心跳的第一价值不是保活，是**让死亡可被察觉**：
// 有稳定的字节流，客户端的读取侧就会在连接断掉时结束/报错，C4 才有机会重连。
// 【为什么用注释行】`:` 开头的行规范要求收端忽略，它不可能被误解析成一个事件——这正是规范
// 留下这个语法的用途。用一个 `event: ping` 心跳的话，收端就得多一条「这个事件名要跳过」的分支，
// 而那条分支与 C2 的收敛事件名全集直接冲突。
// 【为什么是 15 秒】要显著小于常见的 30~60 秒空闲回收阈值，同时代价可以忽略（每次 12 字节）。
// 【定时器必须 `unref()`】活跃的 `setInterval` 会把 Node 的 event loop 钉住。不 unref 的话，
// 一条还开着的 SSE 连接就足以让进程/测试进程永远不退出——症状是「测试跑完了但 vitest 不返回」，
// 排查成本远高于这一行。
//
// ═══ Node 自己的两个超时不会掐这条连接（已实测，不是推断）═══
//
// `http.Server` 有三个可能杀掉长连接的旋钮，逐个核过：
//   · `requestTimeout`（Node 18 起默认 300 秒）计的是「**收完整条请求**要多久」，不是响应活多久。
//     我们的 GET 没有请求体，请求在第一个包就收完了，计时随即作废。
//   · `headersTimeout`（默认 60 秒）同理，只管请求头。
//   · `server.timeout`（socket 空闲超时）自 Node 13 起默认是 **0 = 关**；`keepAliveTimeout`
//     只在两次请求**之间**生效，响应还在写的时候不参与。
// 探针把 `requestTimeout` 压到 150ms、`headersTimeout` 压到 100ms，一条每 50ms 写一次的 SSE
// 响应跑满 1200ms 仍未被关闭。所以这条链路上唯一会掐连接的是**我们自己之外**的东西
// （浏览器、操作系统、以及用户可能自己套的反向代理）——这正是上面那节心跳存在的理由。
// 也因此本模块**不设** `x-accel-buffering: no`：`authGuard.ts` 只放行回环对端，我们与浏览器
// 之间按设计没有中间层；真把这台 server 藏到 nginx 后面的人，要处理的不止这一个头。
//
// ═══ 背压：刻意不管，且这条不可外推 ═══
//
// `response.write()` 返回 `false` 表示内核缓冲满了，Node 会继续在内存里排队。本端点无视这个
// 返回值，因为它的产出速率**有上界**：两个低频生命周期事件 + 每 15 秒 12 字节的心跳。一个
// 完全不读的客户端，一小时也只能让我们排上几 KB，而它的 socket 早会先被超时收掉。
// **这个结论是本端点特有的，不是一条通用做法。** M 线的模型流式响应是按请求的、高频的、
// 每帧可能上 KB 的东西，照抄这里等于给自己开一个「慢客户端 = 服务端内存无上限」的口子——
// C2 的文件头已经点名那件事需要 `events/` 下另一套机制（带背压与取消），不是本契约。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOST_EVENT_NAMES, type HostEventSource } from '@web-agent/host-node'
import { encodeSseComment, encodeSseFrame, EVENT_STREAM_CONTENT_TYPE } from './eventsRouteFrame'

/** 见文件头「心跳」一节。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

export interface EventStreamOptions {
  /** 事件来源，C2 的 `createHostEventBus()` 的订阅面那一半。 */
  readonly events: HostEventSource
  /**
   * 心跳间隔毫秒。默认 `DEFAULT_HEARTBEAT_INTERVAL_MS`；传 `0` 或负数/非有限值 = **关掉心跳**。
   * 关掉是给测试用的（不想让每条用例都被一个定时器拖着），生产不要传。
   */
  readonly heartbeatIntervalMs?: number
}

export function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: EventStreamOptions,
): void {
  const unsubscribes: Array<() => void> = []
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let open = true

  function closeStream(): void {
    if (!open) return
    open = false
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    // C2 的取消函数本身是幂等的，但重复走这个循环没有意义；`open` 已经把重入挡在门外。
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes.length = 0
  }

  function push(chunk: string): void {
    if (!open) return
    if (response.writableEnded || response.destroyed) {
      // 还没等到 `'close'` 就已经写不动了：立刻按断开处理，别等事件绕回来。
      closeStream()
      return
    }
    try {
      response.write(chunk)
    } catch {
      // 往一条已经没了的连接上写，只可能是一件事：对端走了（EPIPE / ECONNRESET /
      // ERR_STREAM_DESTROYED）。这**不是异常情况**，是用户关标签页的正常形态，所以不往
      // `onInternalError` 报——把关标签页记成一次服务端事故，会让真正的事故淹没在噪声里。
      // 唯一要做的就是收账。
      closeStream()
    }
  }

  // ① 先挂断开监听，再动任何字节。顺序理由见文件头。
  response.on('close', closeStream)
  response.on('error', closeStream)
  // ② 复查一次：客户端可能在本 handler 被调用之前就断了，那时 `'close'` 已经发射过。
  if (response.destroyed || response.writableEnded) {
    closeStream()
    return
  }

  // ③ 响应头。**刻意没有 `content-length`**——这是 `httpReply.ts` 三条共同要求里唯一一条在这里
  //    不成立的：流的长度在连接结束前不知道，给不出来。另外两条（`no-store` 与 `nosniff`）照旧，
  //    理由与那边逐字相同。缺 `content-length` 的后果是 Node 走 chunked 传输编码，收端透明拆包。
  response.statusCode = 200
  response.setHeader('content-type', EVENT_STREAM_CONTENT_TYPE)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.flushHeaders()
  // Nagle 会把一次小写入压在缓冲里等后续数据凑一个大包，而 SSE 的每一帧恰好就是「几十字节，
  // 后面没有了」这种最坏形状——事件因此可能被推迟几十毫秒才真的上线。
  request.socket.setNoDelay(true)

  // ④ 立刻写一条注释行：让头部与首字节马上出去，`curl -N` 也能一眼看出连接是活的。
  push(encodeSseComment('connected'))

  // ⑤ 订阅。**遍历 `HOST_EVENT_NAMES` 而不是手写两个名字**：手写等于在 C2 的全集之外又立一个
  //    权威，而两者漂移的症状是「某个事件在 CLI 上有、过了 HTTP 就没了」——静默。本层是传输，
  //    对载荷一无所知也不需要知道，加第三个事件时这里天然就通了（该被迫改的是消费方 C4）。
  for (const name of HOST_EVENT_NAMES) {
    unsubscribes.push(options.events.onHostEvent(name, (payload) => {
      // 载荷的 JSON 安全性由 C2 在 emit 时**已经**逐值校验过（`jsonPayload.ts`，运行期那一遍
      // 在任何 handler 被调用之前跑完）。这里因此不再防一遍，更不做任何「整形」——补默认值、
      // 删空字段、改大小写，每一样都会让进程内订阅者与 SSE 订阅者看到不同的值，而消灭这种
      // 分岔正是 C2 那套约束的全部目的。
      push(encodeSseFrame(name, JSON.stringify(payload)))
    }))
  }

  // ⑥ 心跳。放在订阅之后：先保证事件通道通，再谈保活。
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    heartbeat = setInterval(() => { push(encodeSseComment('heartbeat')) }, heartbeatIntervalMs)
    heartbeat.unref()
  }
}
