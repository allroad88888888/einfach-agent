// 测试脚手架（发请求那半边）：一个能逐块读、能中途断开的原始 HTTP 客户端。
// ---------------------------------------------------------------------------
// **不用 `fetch`**，两个理由：
//   · 本卡要测的是「客户端关标签页」这件事本身，而 `AbortController` + fetch 与真正的
//     `socket.destroy()` 在服务端看到的形态不一定一样；`request.destroy()` 就是把连接掐掉。
//   · 方法、Content-Type、正文都要能逐字写进请求行/请求头（405 / 415 / 400 那几条用例），
//     `http.request({ method, headers })` 不做任何归一。
//
// `complete` 是「响应头之后失败」的可观测形态：服务端 `response.destroy()` 之后，chunked 响应
// 少了结尾那个 0 长度块，Node 把这条消息标成未完成。**这正是「状态码已经写出去了、只能断连」
// 与「回一条完整的错误响应」的区别**，用例靠它把 findings #22 的两种「响应过大」分开。

import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { MODEL_ROUTE_PATH } from './modelRoutePath'

export interface RawRequestInit {
  readonly method?: string
  readonly path?: string
  readonly headers?: Record<string, string>
  /** 原样写进请求体的字符串；不传时不发正文。 */
  readonly body?: string
}

export interface ModelRouteProbe {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  /** 响应是不是完整收到的。服务端中途断连时为 false。 */
  readonly complete: boolean
}

function openRawRequest(port: number, init: RawRequestInit) {
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: init.path ?? MODEL_ROUTE_PATH,
    method: init.method ?? 'POST',
    // Node 的全局 agent 默认开 keep-alive，连接不关会让 `server.close()` 一直等，
    // 表现为用例超时而不是失败。
    agent: false,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  // 自己断开连接时 ClientRequest 会抛 ECONNRESET；不接住就是一次未捕获异常。
  request.on('error', () => undefined)
  if (init.body === undefined) request.end()
  else request.end(init.body, 'utf8')
  return request
}

/** 发一条请求并把响应整条读完。 */
export async function sendModelRequest(
  port: number,
  init: RawRequestInit = {},
): Promise<ModelRouteProbe> {
  const request = openRawRequest(port, init)
  const [response] = (await once(request, 'response')) as [IncomingMessage]
  response.on('error', () => undefined)
  const chunks: Buffer[] = []
  try {
    for await (const chunk of response) chunks.push(Buffer.from(chunk as Buffer))
  } catch {
    // 服务端中途断连：已经收到的部分留下，`complete` 会是 false。
  }
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks).toString('utf8'),
    complete: response.complete,
  }
}

export interface PendingModelRequest {
  /** 客户端主动断开——不等响应头。 */
  abort(): void
}

/**
 * 发一条请求就返回，**不等响应头**。
 *
 * 「客户端在上游握手期间就走了」这条路径没法用等响应头的客户端构造：那时候响应头压根还不存在。
 */
export function sendWithoutWaiting(port: number, payload: unknown): PendingModelRequest {
  const request = openRawRequest(port, { body: JSON.stringify(payload) })
  return { abort: () => request.destroy() }
}

export interface OpenModelStream {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  /** 取下一块；流正常结束时返回 undefined。 */
  next(): Promise<Buffer | undefined>
  /** 读到底（或读到断连）。 */
  collect(): Promise<{ readonly text: string, readonly complete: boolean }>
  /** 客户端主动断开——模拟关标签页。 */
  abort(): void
}

/**
 * 发一条请求，**拿到响应头就返回**，之后由用例逐块驱动。
 *
 * 「拿到响应头就返回」本身就是一条判据：如果这一层把响应攒完再发，下面这行 `once(request,
 * 'response')` 会一直等到上游 end——而流式用例里的假上游故意不 end。
 */
export async function openModelStream(port: number, payload: unknown): Promise<OpenModelStream> {
  const request = openRawRequest(port, { body: JSON.stringify(payload) })
  const [response] = (await once(request, 'response')) as [IncomingMessage]
  response.on('error', () => undefined)
  const iterator = response[Symbol.asyncIterator]()
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    async next() {
      const step = await iterator.next()
      return step.done ? undefined : Buffer.from(step.value as Buffer)
    },
    async collect() {
      const chunks: Buffer[] = []
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done) break
          chunks.push(Buffer.from(step.value as Buffer))
        }
      } catch {
        // 断连：留下已收到的部分。
      }
      return { text: Buffer.concat(chunks).toString('utf8'), complete: response.complete }
    },
    abort() {
      request.destroy()
    },
  }
}
