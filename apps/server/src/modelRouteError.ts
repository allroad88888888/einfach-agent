// 把「响应头还没交出去」的转发失败映射成一条 HTTP 错误响应。
// ---------------------------------------------------------------------------
// 【只映射响应头之前的失败】M1 定的分界线是**响应头有没有交出去**：交出去之前
// `forwardProviderRequest` 直接 reject，此时状态码还没写，我们能给出一条完整的失败响应；
// 交出去之后错误从 generator 里抛，那时状态码改不回来了，唯一诚实的处理是断连
// （`modelRoute.ts` 的 `response.headersSent` 分支），**不经过本模块**。
//
// 【判据是 `reason` 字段，不是文案、也不是 `instanceof`】
// host-node 的 model 域给每个失败挂了一个 `reason`（闭合枚举，见该域 errors.ts 的文件头），
// 本模块是它到 HTTP 状态码的**唯一**映射表。两条都不能换成别的写法：
//   · 不按文案分支——那些中文串是**给人看的对外契约**，桌面宿主与 Node 宿主必须说同一句话。
//     在这里照抄一份来 switch，等于给同一份契约立第二个权威：那边改一次措辞，这里静默落进
//     兜底分支，状态码退化成 502 而没有任何编译错误。`modelRouteErrorMessageGuard.test.ts`
//     机械盯住这一条。
//   · 不按 `instanceof` 分支——错误要跨 HTTP 边界序列化（今天 apps/server 与 host-node 同进程，
//     将来 sidecar 那条路上原型没了，类型身份保不住），那一头拿到的是一袋 JSON，只有字段还在。
//     这与 invokeRouteError.ts 按 `NodeHostCommandErrorReason` 分派是同一条规矩。
//
// 【状态码怎么定的】按「调用方拿到它该做什么」，不按「错得多严重」：
//   400 请求本身不合契约，调用方改请求再来。
//   403 策略拒绝（供应商/作用域/端点组合未获允许），重试无用，换目标。
//   409 requestId 撞上一次**在飞**的请求；换个 id 重发即可，上一次还活着。
//   500 宿主自己的 config.json 那一段坏了——不是调用方的错，也不是上游的错，重试无用。
//   502 这次上游往返没成（连不上、超时、响应过大）。可重试。
//   503 这一条模型凭证没配。补上 Key 之后就能用，所以是「暂时不可用」而不是 4xx。
//   499 客户端自己取消（nginx 惯例，非 IANA 注册码）。
//
// 【这些状态码到得了用户眼前，那句中文到不了——本层刻意不为此改信封形状】
// `@einfach-agent/ai` 的 `modelRetry.ts` 把每次非 2xx 脱敏成一句英文：
// `Chat completion returned <status> (<category>…)`。它**保留状态码本身**，`category` 又是一张
// status→词的表（400 invalid_request / 403 permission_error / 409 conflict / 5xx upstream_error），
// 这句话经 `runToolLoop` 落到 `run.error`、由 Composer 直接渲染。所以本表一分开，用户当场就能
// 把「请求写错了」「目标不允许」「id 撞了」与「上游挂了」分开——M6 之前它们全是 `502 (upstream_error)`。
// 到不了的是 `message` 那句中文：`safeProviderErrorFields` 只从响应体里取 `error.type/.code/.param`
// 三个短标识，**故意不取 message**（错误体不可信）。
// 把本层信封改成嵌套的 `{ error: { type, code }, message }` 能让 `reason` 挤进那条白名单，但不做：
//   ① 那两个字段叫 `provider_*`，意思是「**供应商**说的」。本机 host 的分类塞进去，摘要行会断言
//      一件假的事；而且上游自己的错误体也走同一条白名单（非 2xx 连状态码带 body 一起透传），
//      两者在那行里根本分不开。
//   ② `/api` 面的失败信封是扁平的 `{ error: string, message: string }`（requestRouter / invokeRoute /
//      health，以及本端点的 405/415/413/400 都是它）。只改「转发失败」这一支 → 同一个端点两种信封；
//      全改 → 这一个端点与整个 API 面分叉。
//   ③ 桌面宿主给不出同一个字段（那边失败是 invoke reject，摘要恒为 transport failed），
//      同一种失败在两个宿主上读起来会不一样——正是本域文案纪律要避免的。
// 真要让它在 UI 上变成一句中文，机制早就在了、且离用户更近：Composer 的 `formatRunError` 已经
// 在按状态码翻译（今天只有 401 那条）。那是 apps/web 的改动面，不是本层。
//
// 【为什么只取 `message`，不碰 error 对象本身】
// 用户的模型 API Key 在 Node 侧只出现在两处（配置读出来的局部变量、发给上游的 Authorization
// 头）。M1 为此在上游失败时**刻意丢掉原始 error**——undici 的 cause 链里带着请求 URL 与头部
// 摘要，而头部里有 Authorization。本层照同一条纪律：只取 `message` 这个字符串，
// **不取 `stack`、不取 `cause`、不 JSON 化 error 对象**，也不写任何日志。message 直接透传
// host-node 已经写好的那句中文，不在这里另组一遍（与 invokeRouteError.ts 复用文案的理由相同）。

import { readModelRequestErrorReason, type ModelRequestErrorReason } from '@einfach-agent/host-node'

export interface ModelRouteErrorReply {
  readonly statusCode: number
  readonly error: string
  readonly message: string
}

/** 非 `Error` 的抛出物（理论上不该发生）落到这句，而不是把一个未知值字符串化后发出去。 */
const FALLBACK_MESSAGE = '模型请求失败。'

/**
 * reason → (状态码, 机器可读的 error 码)。**穷举**：`Record<ModelRequestErrorReason, …>` 让
 * host-node 那头新增一类失败时，这里当场是编译错误，而不是运行时静默落进兜底。
 */
const REPLY_BY_REASON: Record<ModelRequestErrorReason, { statusCode: number; error: string }> = {
  'invalid-request': { statusCode: 400, error: 'invalid_model_request' },
  'duplicate-request-id': { statusCode: 409, error: 'duplicate_model_request_id' },
  'target-not-allowed': { statusCode: 403, error: 'model_target_not_allowed' },
  'credential-missing': { statusCode: 503, error: 'model_credential_missing' },
  'credential-config-invalid': { statusCode: 500, error: 'model_credential_config_invalid' },
  'upstream-failed': { statusCode: 502, error: 'model_request_failed' },
  cancelled: { statusCode: 499, error: 'request_cancelled' },
}

/**
 * 没带 reason 的抛出物（host-node 内部真的出 bug 了，或者别的库抛上来的）。
 *
 * 落 502 而不是 500：本端点是个网关，「这次上游往返没成」是它对未知失败最不容易误导的说法，
 * 也与 M6 之前的行为一致。**不猜**具体分类——把未知失败硬塞进某一类，等于把一个 bug 说成一句
 * 确定的诊断。
 */
const UNCLASSIFIED = REPLY_BY_REASON['upstream-failed']

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return FALLBACK_MESSAGE
  const message = error.message.trim()
  return message.length > 0 ? message : FALLBACK_MESSAGE
}

export function mapModelRouteError(error: unknown): ModelRouteErrorReply {
  const reason = readModelRequestErrorReason(error)
  const reply = reason === undefined ? UNCLASSIFIED : REPLY_BY_REASON[reason]
  return { statusCode: reply.statusCode, error: reply.error, message: errorMessage(error) }
}
