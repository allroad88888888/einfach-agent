// HTTP 版模型传输 —— 把一份规范信封打到 `POST /api/model/request`（M2 的流式端点），
// 与 `createTauriModelFetch` 同形状（都经 `createProviderFetch` 挂成 `typeof fetch`）。
// ---------------------------------------------------------------------------
// 【不复用 Channel 编解码：响应方向一个字节都不解】
// 桌面那条路把响应切成 `ModelProxyEvent`（`response` / `chunk` / `end` / `error`）从 Tauri
// `Channel` 回来，`tauriModelTransport.ts` 因此要手搓一条 `ReadableStream`、把事件重新拼成一个
// `Response`（还得自己维护 `responseResolved` / `hasResponseBody` 那几个状态位）。HTTP 上那一整层
// 是多余的：`fetch` 的返回值**本来就是**「响应头先到、body 是一条流」，而 M2 那头正是按这个形状
// 写的——`flushHeaders()` 让响应头在第一个 chunk 之前就出去（否则「模型开始回话」会被推迟到第一个
// token），chunk 边界原样保留不重编码。所以本文件只用请求方向的编码
// （`encodeProviderWireRequest` → `providerWireBody.ts` 的 base64，multipart 必须能进 JSON），
// **响应方向没有任何解码**。
//
// 【取消：signal 直接交给 fetch，不另发一条取消命令】
// 判据是「上游那次生成真的停了」，不是「本地这个 promise 早点 reject」。这条通路是现成的，
// 全程不需要本层做第二件事：
//   `controller.abort()` → 浏览器中止这次 fetch、断掉连接
//   → M2 `modelRouteStream.ts` 的 `response.on('close')`（分界判据是 `!writableEnded`：正常收尾
//     同样会触发 close，只有它能分开「我们写完了」与「对方先走了」）
//   → 还**没**拿到上游响应头 → `cancelInFlightModelRequest(registry, 信封)`：按 **requestId** 在
//     在飞请求表上取消，与 `cancel_model_provider_request` 命令同一张表、同一个动作；
//   → **已经**拿到响应头 → `forwarded.release()`：cancel 掉上游 reader，undici 随即销毁那条连接。
// 桌面侧要显式 `invoke('cancel_model_provider_request', { requestId })`，是因为 Tauri 的 Channel 上
// **没有**「调用方走了」这个信号——IPC 不会因为 JS 侧丢掉一个 promise 就去通知 Rust。HTTP 有：
// 连接断开本身就是那个信号，而且它连「响应头还没交出来的那几十秒」都覆盖得到（M2 为此把
// `watchClientConnection` 装在 `forwardProviderRequest` **之前**）。在这里再补发一条
// `POST /api/invoke/cancel_model_provider_request` 只会在页面正在关闭的那一刻多发一次请求，
// 而它想取消的东西已经被同一次断开取消掉了。
//
// 【非 2xx 一律原样交回，不翻译成 reject —— 与桌面那条路的一处有意差异】
// 桌面侧的代理级失败（Rust `Err(String)`）表现为 `invoke` reject，于是 `createTauriModelFetch`
// 也 reject。HTTP 上做不到等价区分，也不该做：本端点**成功时会把上游状态码原样透传**
// （M2 `writeUpstreamHead`），所以一个 502 既可能是本机 server 的失败信封 `{error, message}`，
// 也可能是 DeepSeek 真的回了 502——客户端手里没有任何能分开这两者的凭据，除非去比对中文文案，
// 而那正是 M6 要消灭的第二权威。于是本层不猜：**收到什么 Response 就交回什么 Response**。
// 这不会让调用方少拿到信息——`@einfach-agent/ai` 的 `requestOnce` 对两种形态的处置本来就同级：
// 非 2xx → `Chat completion returned <status> (…)`（≥500 与 429 走重试）；transport 抛错 →
// `Chat completion transport failed (network_error).`（也走重试）。两条路都在那一层被脱敏成
// 一句英文，中文原文谁都拿不到。真要让「没配 Key / 目标未获允许」在 UI 上分得开，正解是 M6 给
// host-node 的错误加 `reason`、M2 按 `reason` 分状态码，而不是在浏览器里照抄一份文案表。
//
// 【认证与 `host/serverInvoke.ts` 共用同一个取 token 的函数，不另写一份】
// `getServerInvokeToken()` 是那条链路的第④跳（读 `location.search` → 存 sessionStorage → 抹掉
// 地址栏），它有副作用且「query 赢 sessionStorage」的裁决只写在那一处。本文件复用它，不复制它：
// 两份读 token 的逻辑迟早在「哪个赢」上分叉，而分叉的症状是「换了新链接还是 401」。
// 没有 token 时**不带** `authorization` 头（不是带一个空 Bearer），也照样把请求发出去——让
// `authGuard.ts` 给出那句准确的 401，客户端不另编一句文案。这三条都与 serverInvoke.ts 逐字同款。

import type {
  ProviderTransport,
  ProviderTransportInput,
} from '@einfach-agent/ai'
import { getServerInvokeToken, type ServerInvokeTokenEnvironment } from '../host/serverInvokeToken'
import { createProviderFetch } from './providerFetch'
import { encodeProviderWireRequest } from './providerWireEnvelope'

/**
 * 与 `apps/server/src/modelRoutePath.ts` 的 `MODEL_ROUTE_PATH` 对应（同名是刻意的：改一处时
 * grep 得到另一处）。相对路径不带 origin——这层从不跨源，页面本身就是这台 server 发出来的产物。
 * 不 import `apps/server` 的任何源码：app 对 app 不是成立的依赖方向（同 serverInvoke.ts）。
 */
export const MODEL_ROUTE_PATH = '/api/model/request'

/** 本文件用得到的 fetch 形状；写窄便于测试注入假实现（同 serverInvoke.ts / resolveHost.ts）。 */
export type ServerModelFetch = (input: string, init: RequestInit) => Promise<Response>

const defaultServerModelFetch: ServerModelFetch = (input, init) => globalThis.fetch(input, init)

export interface ServerModelTransportOptions {
  readonly fetch?: ServerModelFetch
  readonly tokenEnvironment?: ServerInvokeTokenEnvironment
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/** 造这次请求的 init。`signal` 原样交给 fetch —— 见文件头「取消」那一段，它就是整条取消通路。 */
function requestInit(
  body: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  return {
    method: 'POST',
    headers: buildHeaders(token),
    body,
    signal,
    // 本端点靠 `Authorization` 头认证，不靠 cookie；带上只会给 CSRF 多一个面。
    credentials: 'omit',
    // 模型响应绝不该被任何一级缓存留下（M2 那头也设了 `cache-control: no-store`）。
    cache: 'no-store',
    // 我们自己的 server 在这条路径上从不重定向；真收到一次就说明中间有人在拦，此时把请求跟过去
    // 等于把信封（连同 Authorization 头）交给一个未知目标，宁可当场失败。
    redirect: 'error',
  }
}

/** 造浏览器 + 本机 Node 后端这条路上的受限模型传输。 */
export function createServerProviderTransport(
  options: ServerModelTransportOptions = {},
): ProviderTransport {
  const fetchImpl = options.fetch ?? defaultServerModelFetch
  return {
    async request(input: ProviderTransportInput): Promise<Response> {
      // 目标白名单、大小硬顶与 `signal.throwIfAborted()` 都在这一步（与桌面/中继同一份编码器）：
      // 越界的请求、以及已经取消的请求，连一次 HTTP 都不该发出去。
      const request = await encodeProviderWireRequest(input)
      const token = getServerInvokeToken(options.tokenEnvironment)
      return fetchImpl(MODEL_ROUTE_PATH, requestInit(JSON.stringify(request), token, input.signal))
    },
  }
}

/** 保持既有的 fetch 注入面：模型 adapter 拿到的仍是一个 `typeof fetch`。 */
export function createServerModelFetch(options: ServerModelTransportOptions = {}): typeof fetch {
  return createProviderFetch(createServerProviderTransport(options))
}
