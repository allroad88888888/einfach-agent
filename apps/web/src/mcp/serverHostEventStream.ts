// 本机 Node 服务的宿主事件流：`GET /api/events` 的 SSE 订阅（C3 的客户端那一半）。
// ---------------------------------------------------------------------------
// 这是 Tauri 侧 `listen('mcp-stdio-*')` 在 server 宿主上的对应物。**形状刻意不同**：
// Tauri 的 `listen` 是每条连接各挂两个 handler、由运行时负责投递；这里是**一条共享的长连接**，
// 由本模块把帧解析出来再扇出给订阅方。理由是传输本身——一台 server 只需要一条 SSE 连接，
// 每个 MCP 会话各开一条等于把同一份广播收 N 遍。
//
// ═══ 为什么不用 `EventSource` ═══
// 它设不了请求头，而 `/api/*` 一律要 `Authorization: Bearer`（`apps/server/src/authGuard.ts`）。
// C3 已经裁决过：**不退回 `?token=`**（那会拆掉「必须带自定义头」这道跨源防线，并让凭据挂在
// 一条长连接的 URL 上），改用 `fetch` + `ReadableStream` 自己读响应体。代价是失去内建重连与
// `Last-Event-ID` 续传——两样这条端点本来都不打算用。
//
// ═══ 【必须做】(重)连成功 = 一次状态重新同步的触发点 ═══
// C3 明确不保证重连不丢事件：不发 `id:`、不认 `Last-Event-ID`、服务端不留重放缓冲。
// 于是**每次**连上（含第一次）都要通知订阅方重新确定真相，而不是续上一条时间线。
// 本模块只负责发出这个信号（`onStreamConnected`）；具体怎么补偿是订阅方的事——
// `serverStdioConnector.ts` 拿它去对每个还活着的会话重拉一次 `mcp_list_tools`。
// 还有一段同源的窗口：从发起 `fetch` 到服务端装上订阅之间发生的事件同样收不到，
// 所以「第一次也要做」不是客套话。
//
// ═══ 退避在客户端 ═══
// 连不上就指数退避（500 ms 起、30 s 封顶），不贴着服务端重试。**连上过一次就把退避打回起点**，
// 否则一条正常存活数小时后偶然断开的连接，会带着上次失败攒出来的 30 s 去重连。
//
// ═══ 事件名与载荷形状：本地声明，权威在别处 ═══
// 权威是 `packages/host-node/src/events/hostEventNames.ts` 与 `hostEventPayloads.ts`
// （它们自己再与 `apps/desktop/src/mcp_lifecycle.rs` 逐字对拍）。这里**不 import**
// `@einfach-agent/host-node`：那个 barrel 会把整台 Node 宿主（`node:child_process`、
// `node:fs`…）拖进浏览器产物，`vite.config.ts` 的 alias 注释写明了「Web 产物里不该出现」。
// 同 `host/serverInvoke.ts` 本地声明 `INVOKE_ROUTE_PREFIX` 的理由：跨 app / 跨运行环境的常量
// 照抄一份，改的时候两边一起改。

import { getServerInvokeToken, type ServerInvokeTokenEnvironment } from '../host/serverInvokeToken'
import { createServerSseParser, type ServerSseEvent } from './serverSseParser'

/** 与 `apps/server/src/eventsRoutePath.ts` 的 `EVENTS_ROUTE_PATH` 对应。相对路径：页面与服务同源。 */
export const HOST_EVENTS_ROUTE_PATH = '/api/events'

/** 与 `packages/host-node/src/events/hostEventNames.ts` 的 `HOST_EVENT_NAMES` 逐字对应。 */
export const SERVER_HOST_EVENT_NAMES = ['mcp-stdio-tools-changed', 'mcp-stdio-close'] as const

export type ServerHostEventName = (typeof SERVER_HOST_EVENT_NAMES)[number]

const HOST_EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(SERVER_HOST_EVENT_NAMES)

/**
 * 运行期判据。收 `unknown` 而不是 `string`：从线上读回来的 `event:` 字段是外部输入，
 * 让调用方先自己判一次 `typeof` 等于把同一件事写两遍，而漏写的那次就是一次崩溃。
 */
export function isServerHostEventName(value: unknown): value is ServerHostEventName {
  return typeof value === 'string' && HOST_EVENT_NAME_SET.has(value)
}

export interface ServerHostEvent {
  readonly name: ServerHostEventName
  /** 已确认是普通对象的载荷；字段收窄由订阅方按事件名各自负责。 */
  readonly payload: Record<string, unknown>
}

export interface ServerHostEventSubscriber {
  onEvent(event: ServerHostEvent): void
  /** 每次（含第一次）拿到 200 响应头之后调用一次。见文件头「状态重新同步」。 */
  onStreamConnected(): void
}

export interface ServerHostEventStream {
  /** 订阅。第一个订阅者到来时连接开启，最后一个退订时连接关闭。返回幂等的退订函数。 */
  subscribe(subscriber: ServerHostEventSubscriber): () => void
}

/** 本模块用得到的响应形状；写窄便于测试注入假实现（同 `host/resolveHost.ts` 的写法）。 */
export interface ServerHostEventStreamReader {
  read(): Promise<{ readonly done: boolean, readonly value?: Uint8Array }>
  cancel(): Promise<void> | void
}

export interface ServerHostEventStreamResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: { getReader(): ServerHostEventStreamReader } | null
}

export type ServerHostEventStreamFetch = (
  input: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly signal: AbortSignal
  },
) => Promise<ServerHostEventStreamResponse>

const defaultStreamFetch: ServerHostEventStreamFetch = (input, init) => (
  globalThis.fetch(input, init) as unknown as Promise<ServerHostEventStreamResponse>
)

export interface ServerHostEventStreamOptions {
  readonly fetch?: ServerHostEventStreamFetch
  readonly tokenEnvironment?: ServerInvokeTokenEnvironment
  /** 首次退避间隔，默认 500 ms。传 0 = 立刻重连（测试用）。 */
  readonly initialReconnectDelayMs?: number
  /** 退避上限，默认 30 s。 */
  readonly maxReconnectDelayMs?: number
  /**
   * 连接层失败的去处（连不上、非 200、流中途断掉、载荷不是 JSON）。默认**静默**：
   * 这些在正常使用里全是常态（关标签页、重启 server），往控制台刷只会淹掉真问题。
   */
  readonly onStreamError?: (error: unknown) => void
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 500
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createServerHostEventStream(
  options: ServerHostEventStreamOptions = {},
): ServerHostEventStream {
  const fetchImpl = options.fetch ?? defaultStreamFetch
  const initialDelayMs = options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS
  const maxDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS
  const report = options.onStreamError ?? (() => {})
  const subscribers = new Set<ServerHostEventSubscriber>()
  let controller: AbortController | undefined

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    // 没有 token 时不带这个头（同 `host/serverInvoke.ts`）：空 Bearer 值在服务端一样被判成
    // 「没带」，省得那边多想一步。拿不到 token 时服务端会回 401，退避重试仍然继续——
    // 用户粘一条带新 token 的链接进同一个标签页之后，下一次重连就能成功。
    const token = getServerInvokeToken(options.tokenEnvironment)
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  function notifyConnected(): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onStreamConnected()
      } catch (error) {
        // 一个订阅方的补偿动作失败，不许连累其余订阅方，更不许把这条流带下去。
        report(error)
      }
    }
  }

  function handleFrame(frame: ServerSseEvent): void {
    // 认不出的事件名一律丢弃，**不 `as`**：这一头拿到的是 `string`（见 C2 的
    // `isHostEventName` 记档）。服务端将来加了新事件而前端没跟上时，这里静静忽略，
    // 而不是造出一个类型上不存在的事件名往下传。
    if (!isServerHostEventName(frame.event)) return
    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch (error) {
      report(error)
      return
    }
    if (!isRecord(payload)) return
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onEvent({ name: frame.event, payload })
      } catch (error) {
        report(error)
      }
    }
  }

  async function pump(reader: ServerHostEventStreamReader, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder()
    const feed = createServerSseParser({ onEvent: handleFrame, onComment: () => {} })
    for (;;) {
      const chunk = await reader.read()
      // `stream: true`：一个被 TCP 切开的多字节 UTF-8 序列不会被解成两个替换字符。
      // 载荷里有中文（close 事件的 message 来自子进程），这条是必需的。
      if (chunk.value !== undefined) feed(decoder.decode(chunk.value, { stream: true }))
      if (chunk.done) {
        feed(decoder.decode())
        return
      }
      if (signal.aborted) return
    }
  }

  /** 跑一次连接。返回「这次真的连上过」——用来决定退避要不要打回起点。 */
  async function readOnce(signal: AbortSignal): Promise<boolean> {
    const response = await fetchImpl(HOST_EVENTS_ROUTE_PATH, {
      method: 'GET',
      headers: buildHeaders(),
      signal,
    })
    if (!response.ok) throw new Error(`本机服务的事件流返回了 HTTP ${response.status}。`)
    const body = response.body
    if (!body) throw new Error('本机服务的事件流没有响应体。')
    // 响应头到达即视为连上：C3 在这一刻就写了一条 `: connected` 注释行，头部不会被压在缓冲里。
    notifyConnected()

    const reader = body.getReader()
    try {
      await pump(reader, signal)
    } catch (error) {
      // 流中途断掉是常态（服务端重启、网络抖动），不是连接失败——报一下就走重连，
      // 而且退避要按「连上过」算，不能带着上次失败攒出来的间隔。
      if (!signal.aborted) report(error)
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 取消一条已经结束的流会抛，纯属收尾噪声。
      }
    }
    return true
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    let delayMs = initialDelayMs
    while (!signal.aborted) {
      let connected = false
      try {
        connected = await readOnce(signal)
      } catch (error) {
        if (signal.aborted) return
        report(error)
      }
      if (signal.aborted) return
      if (connected) delayMs = initialDelayMs
      await sleep(delayMs, signal)
      delayMs = Math.min(Math.max(delayMs * 2, initialDelayMs), maxDelayMs)
    }
  }

  return {
    subscribe(subscriber) {
      subscribers.add(subscriber)
      if (controller === undefined) {
        const started = new AbortController()
        controller = started
        void runLoop(started.signal)
      }
      let done = false
      return () => {
        if (done) return
        done = true
        subscribers.delete(subscriber)
        // 最后一个订阅方走了就把连接收掉。留着的话，一条没有任何消费方的长连接会一直挂在
        // 服务端（并在断线后永远重连下去）——那正是 C3 「断开必须退订」在客户端这一侧的镜像。
        if (subscribers.size === 0 && controller !== undefined) {
          controller.abort()
          controller = undefined
        }
      }
    },
  }
}
