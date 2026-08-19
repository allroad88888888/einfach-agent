// `GET /api/events` 的 handler 工厂：把 C2 的宿主事件面经 SSE 送到浏览器。
// ---------------------------------------------------------------------------
// 本卡（C3）只交一个可测的 handler 工厂 + 一个路径判据，**不改 `requestRouter.ts`**——接线由
// 主会话统一做（M2 也在等同一处）。同 host-node「域只交 registrar」、S3「只交 handler 工厂」的
// 既定协议。要加的那几行写在本卡的交回报告里。
//
// ═══════════════════════════════════════════════════════════════════════════
// 【本卡最关键的一处裁决】`EventSource` 设不了请求头，而 S2 只认 `Authorization: Bearer`
// ═══════════════════════════════════════════════════════════════════════════
//
// 冲突是真的：本端点在 `/api/*` 之下，`authGuard.ts` 会要求 `Authorization: Bearer <token>`；
// 而浏览器内建的 `EventSource` 构造器只收一个 URL（外加 `withCredentials`），**没有任何途径
// 设置自定义请求头**。照最省事的办法走，就是退回 `?token=`——
//
// **不退。** S2 那条裁决不是风格偏好，`?token=` 会一次性拆掉两道东西：
//   1. **它让跨站简单请求重新活过来。** 「必须带一个自定义头」这件事本身就是第四道防线：
//      跨源 JS 要设 `Authorization` 必须先过 CORS 预检，而我们不回任何 `Access-Control-Allow-*`，
//      浏览器**根本不会发出**那条真实请求；`<img>` / `<script>` / `<form>` 更是连头都设不了。
//      token 一旦进 query，一个 `new EventSource('http://127.0.0.1:PORT/api/events?token=…')`
//      就是一条无需预检的 GET——只要 token 泄露过一次（见下一条），任何页面都能长期挂着我们的
//      事件流。
//   2. **query 里的凭据会自己泄露出去。** 它进浏览器历史、进 `Referer`、进任何一层日志。
//      B2 卡为此专门做了「token 从 URL 取一次后立刻从地址栏清掉」，退回 query 等于把 B2 刚
//      擦掉的东西又抹回去，而且是在一条**长连接**的 URL 上——它会在开发者工具的网络面板里
//      一直挂着。
//
// **解法：客户端不用 `EventSource`，改用 `fetch` + `ReadableStream` 读响应体。**
// `fetch` 能设 `Authorization` 头、能用 `AbortController` 取消，`response.body` 是一条
// `ReadableStream<Uint8Array>`，配 `TextDecoder({ stream: true })` 逐块喂给一个按行解析的
// SSE 解析器即可。C4 要写的就是这一段；本卡的测试脚手架
// （`eventsRoute.testHarness.ts` 的 `createSseParser`）已经是一份可以照抄的参考实现，
// 连「CRLF 被 chunk 切成两半」这种坑都标好了。**注意 app 之间没有依赖边，C4 不能 import
// `apps/server`，只能照抄。**
//
// 这个换法要付的两笔代价，都是明码的：
//   · **失去 `EventSource` 的内建自动重连**。重连策略因此归客户端（见下一节，我们本来也不打算
//     用它那套）。
//   · **失去 `EventSource` 的 `Last-Event-ID` 续传**。同下一节：本端点本来就不做重放。
// 换来的是：认证形态与 `/api/invoke` **完全一致**（同一个 `Authorization` 头、同一份 token、
// 同一条 401 路径），server 侧因此一行特例都不用开。为一个我们不打算用的浏览器 API 去掉
// 一整道防线，是这笔账里最不划算的一种。
//
// 顺带一条给 C4 的实证提醒：`fetch` 的 promise 在**响应头**到达时就 resolve，此时 `response.ok`
// 已经可判——401 会在这一刻拿到，不必等流。我们在连接建立时立刻写一条 `: connected` 注释，
// 头部因此不会被压在缓冲里。
//
// ═══ 断线重连：**明确不保证不丢事件**，以及客户端怎么补偿 ═══
//
// 裁决：**不发 `id:`，不认 `Last-Event-ID`，服务端不留任何重放缓冲。** 两条理由：
//
//   1. **重放缓冲没有正确的大小。** 有上限就会「有时补得上、有时静默补不上」，是两种行为里最
//      糟的那种；没上限就是一个随运行时长增长的内存坑。而无论多大，服务端重启后缓冲一定是空的
//      ——而重启恰恰是断线最常见的原因。
//   2. **就算补得上，重放也是错的语义。** 这两个事件是 MCP 会话的生命周期通知，按
//      `(serverId, sessionToken)` 定位。断线之后客户端要的不是「把我漏掉的补给我」，而是
//      **重新确定当前真相**。重放一条五分钟前的 `tools-changed`，让客户端去做一次它本来就该做的
//      `tools/list`；重放一条 `mcp-stdio-close`，则可能让客户端拆掉一个此后已经重连好的会话
//      ——它能不出事全靠 `sessionToken` 对不上这一道过滤，等于把正确性全押在客户端的过滤上。
//      桌面宿主（Rust `app.emit`）同样没有任何重放，C4 要能逐字复用 `tauriStdioConnector.ts`
//      的过滤逻辑，两侧的投递语义就不能一边有重放一边没有。
//
// **客户端（C4）的补偿动作，照此实现**：把「连上事件流」当作一次**状态重新同步**的触发点，
// 而不是续上一条时间线——(重)连成功后，对每个自己认为还活着的 MCP 会话重新拉一次
// `mcp_list_tools`，拉不到的按已关闭处理。这与它收到一条 `tools-changed` 之后要做的事是同一件，
// 不是额外负担。重连退避也在客户端：连不上时指数退避，别贴着服务端重试。
// **还有一段窗口同样不保证**：从客户端发起 `fetch` 到服务端装上订阅之间发生的事件收不到。
// 这与上面是同一条——所以补偿动作必须在**每次**连上之后做，包括第一次。
//
// ═══ 认证：什么都不做，就是正确做法 ═══
//
// 路径在 `/api/*` 之下，`requestRouter.ts` 的 `handleApi` **第一行**就跑完了四道判定
// （对端地址 → Host → Origin → token）。本文件因此一行认证代码都没有，也不该有——
// 「分支里不要再判一遍」是 `requestRouter.ts` 写给 S3 的话，对本卡同样成立。
// 也不申请 health 那样的 token 豁免：health 的豁免有它自己的理由（B1 的宿主探测发生在拿到
// token 之前），事件流没有那个理由，订阅方就是已经拿到 token 的那个页面。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { replyJson } from './httpReply'
import { openEventStream, type EventStreamOptions } from './eventsRouteStream'

export { EVENTS_ROUTE_PATH, isEventsRoutePath } from './eventsRoutePath'
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from './eventsRouteStream'

export type EventsRouteOptions = EventStreamOptions

/**
 * **同步返回，而响应故意留着不关。** 与 `InvokeRouteHandler` 的 `Promise<void>` 不同：那边的
 * 「做完了」等于「响应写完了」，这边的「做完了」只等于「订阅装好了」，连接随后可能活几个小时。
 * 让它返回一个直到断开才 resolve 的 Promise 也行，但那只是给每条连接挂一个永远悬着的 Promise，
 * 换不来任何东西——`requestRouter.ts` 在 `await` 之后不做任何事，而流建立之后的失败
 * （写不动了）本来就只能就地处理，外层那个 try/catch 早已够不着。
 */
export type EventsRouteHandler = (request: IncomingMessage, response: ServerResponse) => void

export function createEventsRouteHandler(options: EventsRouteOptions): EventsRouteHandler {
  return (request, response) => {
    // **GET 之外一律 405，包括 HEAD**（health 那边是 GET + HEAD 都收，这里刻意不同）。
    // HEAD 的语义是「给我 GET 的响应头，别给正文」，而事件流的响应头里最有信息量的那个
    // (`content-length`) 根本不存在，正文才是全部。对 HEAD 回一个 200 + 立刻结束，等于告诉
    // 探测方「这条流是通的」然后马上把它掐了——一次没有任何东西被真正验证过的成功。
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET')
      replyJson(response, 405, { error: 'method_not_allowed', message: '事件流只接受 GET 请求。' })
      return
    }
    openEventStream(request, response, options)
  }
}
