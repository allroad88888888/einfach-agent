// 顶层分派：一条请求要么归 `/api/*`，要么归静态托管。
//
// 【为什么 API 面必须显式兜底，而不是让未匹配的 /api/* 落到静态托管】
// 落下去的后果是「`GET /api/invok`（少打一个 e）返回 200 和一整页 index.html」——调用方拿到的
// 不是错误而是一份 HTML，JSON 解析报在离病因十万八千里的地方。API 面的未知路径一律回 404 JSON。
//
// 【留给 S2 / S3 的接缝】
// - S3（`/api/invoke/:command`）：在 `handleApi` 里 health 之后加一条分支即可，静态那侧不用动。
//   host-node 的失败带 `reason` 字段（`unimplemented` / `unknown-command`），按它映射 501 / 404，
//   不要用 `instanceof`——错误要跨 HTTP 序列化。
// - S2（token 认证与 Origin 校验）：卡口在 `handleApi` 的入口处，即「进 API 面的唯一一道门」。
//   有一个 S2 必须自己裁决、本卡不替它决定的点：**health 要不要一起校验**。B1 拿它做宿主探测，
//   而探测发生在拿到 token 之前；若 health 也要 token，B1 的探测会失败并把 server 宿主误判成
//   static 宿主。两种解法（health 豁免 / B1 带着 token 探测）各有取舍，S2 与 B1 一起定。
// - 静态那侧**不需要**认证：它发的是用户自己 build 出来的公开前端产物，且 B2 要从页面里拿 token。
//   真正危险的是 `/api/*`（一条 `run_shell_command` 就是任意代码执行），S2 的重点在那儿。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHealthPayload, HEALTH_PATH, type HealthFacts } from './health'
import { replyJson, replyText, type ReplyOptions } from './httpReply'
import { requestPathname } from './requestPathname'
import { handleStaticRequest } from './staticFiles'

export interface RequestRouterOptions {
  /** 前端构建产物目录。 */
  readonly distDirectory: string
  /** health 载荷所需的事实，由装配层注入（理由见 health.ts）。 */
  readonly health: HealthFacts
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

function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: RequestRouterOptions,
  replyOptions: ReplyOptions,
): void {
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
        handleApi(request, response, pathname, options, replyOptions)
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
