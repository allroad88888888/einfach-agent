// 把「响应头还没交出去」的转发失败映射成一条 HTTP 错误响应。
// ---------------------------------------------------------------------------
// 【只映射响应头之前的失败】M1 定的分界线是**响应头有没有交出去**：交出去之前
// `forwardProviderRequest` 直接 reject，此时状态码还没写，我们能给出一条完整的失败响应；
// 交出去之后错误从 generator 里抛，那时状态码改不回来了，唯一诚实的处理是断连
// （`modelRoute.ts` 的 `response.headersSent` 分支），**不经过本模块**。
//
// 【为什么这里可以用 `instanceof`，而 invokeRouteError.ts 不行】
// 那边判的是一个可能跨进程/序列化边界传回来的失败（sidecar 那条路上类型身份保不住），所以按
// `reason` 字段判。这里的错误对象是**同一个进程里刚刚抛出来的**——我们直接调用
// `forwardProviderRequest`，中间没有任何序列化，`instanceof` 认得出。
//
// 【为什么其余全部塌成 502，而不是逐条分类】
// M1 的 `MODEL_ERROR`（`模型请求格式无效` / `模型请求目标未获允许` / `模型服务请求失败` /
// `未配置 X API Key` …）是一组常量文案，但它**没有出现在 `@web-agent/host-node` 的公开面上**，
// 也没有给这些错误挂 `reason` 字段。可选项只有两个：在 apps/server 里照抄一份中文串来做
// switch——那等于给一份对外契约立第二个权威，两边一改就漂移；或者承认这一层分不出来。
// 选后者：**状态码粗、message 准**。`message` 是 M1 已经写好的那句中文，直接透传，不再自己组
// 一遍（与 invokeRouteError.ts 复用 host-node 文案的理由相同）。
// 真要细分（比如「没配置 Key」回 503、「目标未获允许」回 403），正解是 M1 给这些错误加
// `reason`，那是 M1 的改动面。
//
// 【为什么只取 `message`，不碰 error 对象本身】
// 用户的模型 API Key 在 Node 侧只出现在两处（配置读出来的局部变量、发给上游的 Authorization
// 头）。M1 为此在上游失败时**刻意丢掉原始 error**——undici 的 cause 链里带着请求 URL 与头部
// 摘要，而头部里有 Authorization。本层照同一条纪律：只取 `message` 这个字符串，
// **不取 `stack`、不取 `cause`、不 JSON 化 error 对象**，也不写任何日志。

import { ModelRequestCancelledError } from '@web-agent/host-node'

export interface ModelRouteErrorReply {
  readonly statusCode: number
  readonly error: string
  readonly message: string
}

/** 非 `Error` 的抛出物（理论上不该发生）落到这句，而不是把一个未知值字符串化后发出去。 */
const FALLBACK_MESSAGE = '模型请求失败。'

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK_MESSAGE
  const message = error.message.trim()
  return message.length > 0 ? message : FALLBACK_MESSAGE
}

export function mapModelRouteError(error: unknown): ModelRouteErrorReply {
  if (error instanceof ModelRequestCancelledError) {
    // 499 不是 IANA 注册码（nginx 惯例：客户端在服务端应答前就走了）。选它而不是某个标准码，
    // 是因为本端点成功时会把**上游的状态码原样透传**——任何标准码都可能与上游真的返回的那个
    // 撞在一起，而这一条的听众恰恰是刚刚发出取消的那个调用方，它的 fetch 本来就已经 abort 了。
    return { statusCode: 499, error: 'request_cancelled', message: error.message }
  }
  // 502：这次请求没能变成一次上游往返。见文件头「为什么其余全部塌成 502」。
  return { statusCode: 502, error: 'model_request_failed', message: errorMessage(error) }
}
