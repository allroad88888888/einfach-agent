// 测试脚手架：起一台只挂了事件流 handler 的真实 server，外加一个按规范解析 SSE 的客户端。
// ---------------------------------------------------------------------------
// 【为什么不复用 `testServer.testHarness.ts`】那边起的是完整 `createWebAgentServer()`，而本卡的
// 路由还没接进 `requestRouter.ts`（接线由主会话统一做），此刻调用它测不到这个 handler。
// 这里另起一台裸 `http.Server`，只挂 `createEventsRouteHandler` 本身。
//
// 【为什么要真起 server，不用假的 `ServerResponse`】本卡最要紧的判据是「断开必须退订」，
// 而它依赖的是 Node 的 http 栈在 socket 断掉时**真的**会在 `ServerResponse` 上触发 `'close'`。
// 一个假对象只能证明「我们调用了自己写的 close」，证明不了那个事件真的会来——而后者才是
// 漏订阅泄漏的唯一防线。
//
// 【关服务器绝不能挂住】SSE 连接自己不会结束，`server.close()` 只停止接受新连接、然后**一直等**
// 现存连接结束。所以这里逐条记下 socket，`close()` 时先全部 `destroy()` 再 `close()`。
// 少了这一步的症状是「用例都过了但 vitest 不返回」。
//
// `agent: false`：Node 全局 agent 默认开 keep-alive，连接不关会让 `server.close()` 一直等
// （同 `testServer.testHarness.ts` / `invokeRoute.testHarness.ts` 的理由）。

import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { HostEventBus, HostEventSource } from '@einfach-agent/host-node'
import { createEventsRouteHandler, EVENTS_ROUTE_PATH, isEventsRoutePath, type EventsRouteOptions } from './eventsRoute'
import { requestPathname } from './requestPathname'

export interface EventsRouteTestServer {
  readonly port: number
  close(): Promise<void>
}

export async function startEventsRouteTestServer(
  options: EventsRouteOptions,
): Promise<EventsRouteTestServer> {
  const handler = createEventsRouteHandler(options)
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    if (!isEventsRoutePath(requestPathname(request.url))) {
      response.statusCode = 404
      response.end()
      return
    }
    handler(request, response)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      server.close()
      await once(server, 'close')
    },
  }
}

/** 起一台 server 跑完 `body`，无论成败都保证收干净——漏了就是 vitest 挂到超时。 */
export async function withEventsRouteServer(
  options: EventsRouteOptions,
  body: (server: EventsRouteTestServer) => Promise<void>,
): Promise<void> {
  const server = await startEventsRouteTestServer(options)
  try {
    await body(server)
  } finally {
    await server.close()
  }
}

/**
 * 一个会**数活跃订阅数**的 `HostEventSource`：包住一个真汇，转发全部行为，只额外记账
 * 「现在还挂着几条订阅」。
 *
 * 为什么需要它：判据「连接断开要取消订阅」在外部不可观测——事件照发、页面已经关了，漏退订与
 * 正常退订在网络上长得一模一样，只有服务端内部的订阅数能区分。数订阅数就是把这条判据变成
 * 一个能断言的量。
 */
export function createCountingSource(bus: HostEventBus): {
  source: HostEventSource
  active: () => number
} {
  let active = 0
  const source: HostEventSource = {
    onHostEvent(name, handler) {
      active += 1
      const unsubscribe = bus.onHostEvent(name, handler)
      let done = false
      return () => {
        if (done) return
        done = true
        active -= 1
        unsubscribe()
      }
    },
  }
  return { source, active: () => active }
}

// ═══════════════════════════════════════════════════════════════════════════
// SSE 解析器 —— **C4 的参考实现**（不能 import：app 之间没有依赖边，只能照抄）
// ═══════════════════════════════════════════════════════════════════════════

export interface SseEvent {
  /** `event:` 字段。收端读回来的是 `string`，判它是不是真事件名要用 C2 的 `isHostEventName`。 */
  readonly event: string
  /** 多条 `data:` 行按 `\n` 拼回来的结果。 */
  readonly data: string
}

export interface SseParserHandlers {
  onEvent(event: SseEvent): void
  onComment(text: string): void
}

const SSE_LINE_BREAK = /\r\n|\r|\n/

/** 规范：字段值里紧跟冒号的那**一个**空格属于分隔符，要去掉；第二个空格是正文。 */
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

/**
 * 增量解析：喂进任意切分的文本块，按规范切行、拼 `data`、遇空行派发一帧。
 *
 * 三处 C4 照抄时容易踩的地方，都在下面标了：
 *   · **跨块的半行必须留在缓冲里**（否则一帧被 TCP 切开就解析不出来）。
 *   · **跨块的 `\r\n` 不能当成两个换行**（会凭空多出一个空行 = 提前派发一帧）。
 *   · **一行里第一个冒号才是分隔符**，正文里的冒号不算（JSON 里全是冒号）。
 *
 * 与规范的一处有意偏离：规范里「data 缓冲为空时不派发」，于是 `data:`（空值）什么也不产出。
 * 这里只要见过至少一条 `data:` 行就派发。本端点的载荷是非空 JSON 对象，正常路径上两者等价；
 * 差异只会出现在「服务端发了一帧空载荷」这种 bug 上，而那时我们要的是看见它，不是吞掉它。
 */
export function createSseParser(handlers: SseParserHandlers): (chunk: string) => void {
  let buffer = ''
  let eventType = ''
  let dataLines: string[] = []

  return (chunk: string) => {
    buffer += chunk
    for (;;) {
      const match = SSE_LINE_BREAK.exec(buffer)
      if (match === null) break
      // 缓冲正好停在一个孤零零的 `\r` 上：它可能是被切开的 `\r\n` 的前半个，等下一块再说。
      if (match[0] === '\r' && match.index + 1 === buffer.length) break
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)

      if (line === '') {
        if (dataLines.length > 0) handlers.onEvent({ event: eventType, data: dataLines.join('\n') })
        eventType = ''
        dataLines = []
        continue
      }
      if (line.startsWith(':')) {
        handlers.onComment(stripOneLeadingSpace(line.slice(1)))
        continue
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1))
      if (field === 'event') eventType = value
      else if (field === 'data') dataLines.push(value)
      // 其余字段（`id` / `retry` / 未知）规范要求忽略——我们本来也不发，见 eventsRouteFrame.ts。
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 客户端
// ═══════════════════════════════════════════════════════════════════════════

export interface SseClientInit {
  readonly path?: string
  readonly method?: string
  readonly headers?: Record<string, string>
}

export interface SseClient {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  /** 已收到的事件，活的数组。 */
  readonly events: readonly SseEvent[]
  /** 已收到的注释行正文（`connected` / `heartbeat`），活的数组。 */
  readonly comments: readonly string[]
  /** 收到的原始文本，供「这不是一条流」的用例（405 之类）直接读正文。 */
  readonly raw: () => string
  waitForEvent(index: number, timeoutMs?: number): Promise<SseEvent>
  waitForComment(index: number, timeoutMs?: number): Promise<string>
  /** 模拟「关标签页」：直接掐掉客户端 socket。 */
  disconnect(): void
  /** 响应流结束（正常结束或被掐断）后 resolve。 */
  readonly ended: Promise<void>
}

const DEFAULT_WAIT_TIMEOUT_MS = 2000

export async function openSseClient(port: number, init: SseClientInit = {}): Promise<SseClient> {
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: init.path ?? EVENTS_ROUTE_PATH,
    method: init.method ?? 'GET',
    agent: false,
    headers: init.headers ?? {},
  })
  request.end()
  const [response] = (await once(request, 'response')) as [IncomingMessage]

  const events: SseEvent[] = []
  const comments: string[] = []
  let raw = ''
  const waiters: Array<() => void> = []
  const notify = (): void => { for (const waiter of [...waiters]) waiter() }

  const feed = createSseParser({
    onEvent: (event) => { events.push(event) },
    onComment: (text) => { comments.push(text) },
  })

  let resolveEnded = (): void => {}
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve })

  // `setEncoding('utf8')` 而不是自己 `chunk.toString()`：内部用 StringDecoder，一个被 TCP 切开的
  // 多字节 UTF-8 序列不会被解成两个替换字符。载荷里有中文和 emoji，这条是必需的。
  response.setEncoding('utf8')
  response.on('data', (chunk: string) => { raw += chunk; feed(chunk); notify() })
  const finish = (): void => { resolveEnded(); notify() }
  response.on('end', finish)
  response.on('close', finish)
  response.on('error', finish)

  function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter = (): void => {
        if (!predicate()) return
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`等待超时（${timeoutMs}ms）：${description}`))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    events,
    comments,
    raw: () => raw,
    ended,
    waitForEvent: async (index, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => {
      await waitUntil(() => events.length > index, timeoutMs, `第 ${index + 1} 条事件`)
      return events[index]!
    },
    waitForComment: async (index, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) => {
      await waitUntil(() => comments.length > index, timeoutMs, `第 ${index + 1} 条注释行`)
      return comments[index]!
    },
    disconnect: () => { request.destroy() },
  }
}

/** 轮询到条件成立为止；给「服务端异步地退订完了」这类无法直接 await 的观察点用。 */
export async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${description}`)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}
