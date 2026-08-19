// 顶层分派：一条请求要么归 `/api/*`，要么归静态托管。
//
// 【为什么 API 面必须显式兜底，而不是让未匹配的 /api/* 落到静态托管】
// 落下去的后果是「`GET /api/invok`（少打一个 e）返回 200 和一整页 index.html」——调用方拿到的
// 不是错误而是一份 HTML，JSON 解析报在离病因十万八千里的地方。API 面的未知路径一律回 404 JSON。
//
// 【认证卡口就在 handleApi 的第一行】
// `/api/*` 的三道防线（回环对端地址 / Origin 与 Host / token）由 `authGuard.ts` 判定，本文件只负责
// 把判定结果翻译成一条响应。**顺序不能动**：认证在路径分派**之前**，所以未通过认证的调用方连
// 「有哪些接口存在」都问不出来——`/api/invok` 拿到的是 401 而不是 404。
// 三道各挡什么攻击、health 为什么豁免 token、无 Origin 头为什么放行，全部写在 `authGuard.ts` 的文件头。
//
// 【留给 S3 的接缝】
// - S3（`/api/invoke/:command`）：在 `handleApi` 里 health 之后加一条分支即可，静态那侧不用动。
//   host-node 的失败带 `reason` 字段（`unimplemented` / `unknown-command`），按它映射 501 / 404，
//   不要用 `instanceof`——错误要跨 HTTP 序列化。**认证已在入口处理完，分支里不要再判一遍。**
// - 顺带一条免费防线：invoke 可以要求 `content-type: application/json`。跨站 `<form>` 只能发那三种
//   简单 content-type，设不了 JSON，于是连预检都过不去；而设自定义 content-type 的 fetch 必须先过
//   CORS 预检，我们不回任何 `Access-Control-Allow-*`，浏览器根本不会发出那条真实请求。
// - 静态那侧**不需要**认证：它发的是用户自己 build 出来的公开前端产物，且 B2 要从页面的 URL query
//   里拿 token。真正危险的是 `/api/*`（一条 `run_shell_command` 就是任意代码执行）。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { authorizeApiRequest, readApiRequestFacts, type ApiAuthConfig } from './authGuard'
import { createHealthPayload, HEALTH_PATH, type HealthFacts } from './health'
import { isEventsRoutePath, type EventsRouteHandler } from './eventsRoute'
import { isInvokeRoutePath, type InvokeRouteHandler } from './invokeRoute'
import { isModelRoutePath } from './modelRoutePath'
import type { ModelRouteHandler } from './modelRoute'
import { replyJson, replyText, type ReplyOptions } from './httpReply'
import { requestPathname } from './requestPathname'
import { handleStaticRequest } from './staticFiles'

export interface RequestRouterOptions {
  /** 前端构建产物目录。 */
  readonly distDirectory: string
  /** health 载荷所需的事实，由装配层注入（理由见 health.ts）。 */
  readonly health: HealthFacts
  /** `/api/*` 的认证配置。**没有「关掉认证」这个选项**——见 createServer.ts 的 `token`。 */
  readonly auth: ApiAuthConfig
  /**
   * `/api/invoke/:command` 的 handler，由装配层建好传进来（`createInvokeRouteHandler`）。
   * 本文件不负责构造它——命令路由表是 host-node 的事，路由分派才是这里的事。
   */
  readonly invokeRoute: InvokeRouteHandler
  /**
   * `/api/model/request` 的 handler（M2）。**不走 invoke 那条统一路由**——那条被 JSON 信封包住，
   * 装不下一个流。转发本身在 host-node 的 `forwardProviderRequest`，这里只做 HTTP 那一层。
   */
  readonly modelRoute: ModelRouteHandler
  /**
   * `/api/events` 的 SSE handler（C3）。**同步返回、响应故意留着不关**——它是一条长连接，
   * 生命周期由客户端断开与宿主事件驱动，不是一次请求-响应。
   */
  readonly eventsRoute: EventsRouteHandler
  /** 未预期异常的去处；默认写 stderr。测试传自己的收集器，免得日志把用例输出淹了。 */
  readonly onInternalError?: (error: unknown) => void
}

export type RequestRouter = (request: IncomingMessage, response: ServerResponse) => Promise<void>

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/** API 面的失败信封：`error` 给程序看（稳定标识），`message` 给人看。S2 / S3 沿用同一形状。 */
function replyApiError(
  response: ServerResponse,
  statusCode: number,
  error: string,
  message: string,
  options: ReplyOptions,
): void {
  replyJson(response, statusCode, { error, message }, options)
}

// **必须是 async 并在调用处 await**：invoke 分支要读 body、要 await 命令执行，不 await 的话它的
// rejection 会绕过下面那个 try/catch 变成未捕获错误，而不是被收成一条 500。
async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: RequestRouterOptions,
  replyOptions: ReplyOptions,
): Promise<void> {
  const decision = authorizeApiRequest(readApiRequestFacts(request, pathname), options.auth)
  if (decision.kind === 'deny') {
    for (const [name, value] of Object.entries(decision.headers ?? {})) response.setHeader(name, value)
    replyApiError(response, decision.status, decision.error, decision.message, replyOptions)
    return
  }
  // 认证已在上面处理完，分支里不要再判一遍。三条 API 路径互不相交，先后无所谓。
  if (isInvokeRoutePath(pathname)) {
    await options.invokeRoute(request, response, pathname)
    return
  }
  if (isModelRoutePath(pathname)) {
    await options.modelRoute(request, response)
    return
  }
  if (isEventsRoutePath(pathname)) {
    // 不 await：SSE 是长连接，handler 同步装好订阅就返回，响应留着不关。
    options.eventsRoute(request, response)
    return
  }
  if (pathname !== HEALTH_PATH) {
    replyApiError(response, 404, 'unknown_endpoint', '未知的接口路径。', replyOptions)
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD')
    replyApiError(response, 405, 'method_not_allowed', '健康检查只接受 GET 与 HEAD 请求。', replyOptions)
    return
  }
  replyJson(response, 200, createHealthPayload(options.health), replyOptions)
}

export function createRequestRouter(options: RequestRouterOptions): RequestRouter {
  const reportError = options.onInternalError ?? ((error: unknown) => { console.error(error) })
  return async (request, response) => {
    // 原样的 pathname：不做归一，路径判定只有 staticPath.ts 一处权威（理由见 requestPathname.ts）。
    const pathname = requestPathname(request.url)
    const replyOptions: ReplyOptions = { includeBody: request.method !== 'HEAD' }
    try {
      if (isApiPath(pathname)) {
        await handleApi(request, response, pathname, options, replyOptions)
        return
      }
      await handleStaticRequest(request, response, pathname, options.distDirectory)
    } catch (error) {
      reportError(error)
      // 响应头已发出就无从改写状态码了，只能断连——但别把这一次异常吞掉，上面已经报过。
      if (response.headersSent) {
        response.destroy()
        return
      }
      replyText(response, 500, '服务端内部错误。\n', replyOptions)
    }
  }
}
