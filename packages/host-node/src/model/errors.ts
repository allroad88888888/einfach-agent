// 本域的失败表达：与 Rust 逐字对齐的错误文案，加两个「流开始之后才可能出现」的错误类型
// ---------------------------------------------------------------------------
// 文案集中在这里而不是散在各文件，是因为它们是**对外契约**：桌面宿主与 Node 宿主必须对同一
// 种失败说同一句话，否则同一个前端在两种宿主下会看到两套提示。逐条标了 Rust 出处，改之前先
// 回那一处核对。
//
// 【为什么错误里永远不能出现 Key】
// 本域是用户模型 API Key 在 Node 侧的唯一读取点。Key 只在两个地方出现：从配置读出来的那个
// 局部变量，和发给上游的 Authorization 头。它**不进**任何一条文案、不进返回值、不进异常。
// 下面这些常量全是定值字符串（没有一条做模板拼接除了 provider 展示名），这不是巧合——
// 「错误消息里带上上下文帮助排查」正是 Key 泄漏最常见的入口。

/** Rust 侧同名文案的逐字副本。出处标在每一行。 */
export const MODEL_ERROR = {
  /** model_proxy_body.rs 的 `invalid_body()` / model_proxy_envelope.rs 的 `invalid_envelope()` */
  invalidRequest: '模型请求格式无效',
  /** model_provider_route.rs 的 `resolve_provider_target` 兜底分支 */
  targetNotAllowed: '模型请求目标未获允许',
  /** model_request_registry.rs 的 `validate_model_request_id` */
  invalidRequestId: '模型请求 ID 无效',
  /** model_request_registry.rs 的 `register` */
  duplicateRequestId: '模型请求 ID 已存在',
  /** model_proxy_http.rs：声明的 content-length 超限、以及流中累计超限 */
  responseTooLarge: '模型响应过大',
  /** model_proxy_http.rs：读上游流出错（含 reqwest 的整体超时） */
  responseInterrupted: '模型响应中断',
  /** model_proxy_http.rs：请求根本没发出去 */
  upstreamFailed: '模型服务请求失败',
  /** model_credentials.rs 的 `credential_binding` */
  scopeNotAllowed: '模型凭证作用域未获允许',
  /** model_credential_config.rs 的 `decode_credentials` */
  invalidConfigFormat: '模型配置文件格式无效',
} as const

/** model_credentials.rs 的 `active_model_credential`。参数是展示名（DeepSeek / GLM / Kimi）。 */
export function missingCredentialMessage(displayName: string): string {
  return `未配置 ${displayName} API Key`
}

/**
 * 响应头已经交出去之后才发生的失败。
 *
 * 单独一个类型是因为它的处理方式和「请求根本没发出去」完全不同：状态码已经写给客户端了，
 * 改不回去，唯一诚实的做法是**断掉连接**（M2 侧 `response.destroy()`），让客户端把这次响应
 * 判成不完整而不是「一次成功但内容被截断」。桌面侧对应的是 `ModelProxyEvent::Error`。
 */
export class ModelProxyStreamError extends Error {
  override readonly name = 'ModelProxyStreamError'
}

/**
 * 这次请求被显式取消了（`cancel_model_provider_request`，或调用方自己的 AbortSignal）。
 *
 * 与桌面侧的形状差异**是刻意的**：Rust 那边取消后 `run_provider_request` 返回 `Ok(())`——它能
 * 这么做是因为响应走的是另一条 Channel，命令本身的返回值没人当结果看。Node 侧响应就是
 * 本函数的返回值，「取消」没有一个能冒充成功的返回值，所以它是 rejection。
 * 调用方（M2）据此断连接，不写任何响应体。
 */
export class ModelRequestCancelledError extends Error {
  override readonly name = 'ModelRequestCancelledError'

  constructor() {
    super('模型请求已取消')
  }
}
