// 本域的失败表达：与 Rust 逐字对齐的错误文案，加一个供宿主外壳判别的 `reason` 字段
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
//
// ═══ 判别面是 `reason` 字段，不是文案、也不是 `instanceof` ═══
// 文案是**给人看的**：它会被改措辞、会被翻译，改一次就把所有按它分支的代码改坏，而且是静默
// 改坏（分支落进兜底、状态码退化成 502，没有任何编译错误）。所以本域每个失败都额外带一个
// `reason`：闭合枚举、机器判别面、**永不随文案改动**。
//
// 用字段而不是 `instanceof`，理由与 createNodeHostInvoke.ts 的 `NodeHostCommandErrorReason`
// 逐字相同：错误要跨 HTTP 边界序列化（apps/server 今天是同进程直接调，将来 sidecar 那条路上
// 类型身份保不住），那一头拿到的是一袋 JSON，只有字段还在。
//
// 宿主外壳按 `reason` 分状态码（apps/server 的 modelRouteError.ts 是唯一的映射表），本文件
// 只负责「这是哪一类失败」，**不知道任何 HTTP 状态码**——那是外壳的词汇，不是本域的。

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
  /**
   * model_credentials.rs 的 `model_credential_set`（`normalized_key` 返回 None）。
   *
   * 只说「格式无效」，**不回显那个值**、也不说它是空白还是超长——回显等于把用户刚敲进来的
   * Key 原样写进一条会被记录、被展示的消息里。
   */
  invalidApiKey: '模型 API Key 格式无效',
  /** model_credential_config.rs 的 `decode_credentials` */
  invalidConfigFormat: '模型配置文件格式无效',
  /**
   * **无 Rust 出处**：openai-compat 的登记接入点不满足 openAiCompatBaseUrl.ts 那条判据。
   *
   * 与 `targetNotAllowed` 分成两句话，是因为补救动作虽然同类（换个地址），但**该换哪个地址**
   * 完全不同：前者是「这个端点组合不在白名单里」，后者是「你登记的那条 base URL 本身不合规」。
   * 同样不回显那个地址——它由用户输入，回显等于把用户敲进来的东西原样写进一条会被展示的消息。
   */
  invalidBaseUrl: '模型接入点地址未获允许',
} as const

export type ModelErrorKey = keyof typeof MODEL_ERROR

/**
 * 失败分类。**粒度按「调用方该做什么」定**，不按文案条数——同一个补救动作的几条文案共用一个
 * reason，各自的 message 仍然把话说清楚。
 *
 *   · `invalid-request`            请求本身不合契约（形状、requestId 格式、API Key 格式）。调用方改请求。
 *   · `duplicate-request-id`       requestId 撞上了一次**在飞**的请求。换一个 id 重发——这不是格式问题，
 *                                  上一次请求还活着，覆盖它会让那一次从此取消不掉（见 requestRegistry.ts）。
 *   · `target-not-allowed`         (provider, scope[, endpoint]) 组合未获允许。**策略拒绝**，重试无用，
 *                                  凭证作用域配对失败同属这一类：同一张配对表、同一个补救（换组合）。
 *   · `credential-missing`         这一条凭证没配。用户去设置里填 Key。
 *   · `credential-config-invalid`  宿主自己的 `config.json` 里那一段坏了。用户去修文件，重试无用。
 *   · `upstream-failed`            这次上游往返没成（连不上、超时、响应过大、流中断）。可重试。
 *   · `cancelled`                  显式取消。
 *
 * 数组是唯一权威，联合类型从它派生——两处各写一份必然分叉，而分叉的症状是 `readModelRequestErrorReason`
 * 把一个合法 reason 当成不认识的，状态码静默退回兜底。
 */
export const MODEL_REQUEST_ERROR_REASONS = [
  'invalid-request',
  'duplicate-request-id',
  'target-not-allowed',
  'credential-missing',
  'credential-config-invalid',
  'upstream-failed',
  'cancelled',
] as const

export type ModelRequestErrorReason = (typeof MODEL_REQUEST_ERROR_REASONS)[number]

/**
 * 文案 → 分类。`Record<ModelErrorKey, …>` 不是装饰：往 `MODEL_ERROR` 加一条却忘了分类，
 * 这里当场是编译错误，而不是运行时落进兜底。
 */
const MODEL_ERROR_REASON: Record<ModelErrorKey, ModelRequestErrorReason> = {
  invalidRequest: 'invalid-request',
  targetNotAllowed: 'target-not-allowed',
  invalidRequestId: 'invalid-request',
  duplicateRequestId: 'duplicate-request-id',
  responseTooLarge: 'upstream-failed',
  responseInterrupted: 'upstream-failed',
  upstreamFailed: 'upstream-failed',
  scopeNotAllowed: 'target-not-allowed',
  invalidApiKey: 'invalid-request',
  invalidConfigFormat: 'credential-config-invalid',
  // 与 targetNotAllowed / scopeNotAllowed 同类：策略拒绝，重试无用，补救是换一个目标。
  invalidBaseUrl: 'target-not-allowed',
}

/** 本域所有失败的基类：带文案，也带分类。 */
export class ModelRequestError extends Error {
  override readonly name: string = 'ModelRequestError'
  readonly reason: ModelRequestErrorReason

  constructor(reason: ModelRequestErrorReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * 造一个受控失败。**抛出点一律走它**，不要再写 `new Error(MODEL_ERROR.x)`——那样造出来的错误
 * 没有 `reason`，外壳只能退回兜底状态码，而这件事没有任何编译期症状。
 */
export function modelRequestError(key: ModelErrorKey): ModelRequestError {
  return new ModelRequestError(MODEL_ERROR_REASON[key], MODEL_ERROR[key])
}

/** model_credentials.rs 的 `active_model_credential`。参数是展示名（DeepSeek / GLM / Kimi）。 */
export function missingCredentialMessage(displayName: string): string {
  return `未配置 ${displayName} API Key`
}

/** 上面那句的受控失败形态。 */
export function missingCredentialError(displayName: string): ModelRequestError {
  return new ModelRequestError('credential-missing', missingCredentialMessage(displayName))
}

/**
 * 从一个来路不明的抛出物上读分类。
 *
 * **只看字段，不看类型身份**：这个函数存在的全部意义就是让判别在序列化之后还成立
 * （见文件头）。不认识的形状回 `undefined`，由调用方决定兜底——把未知失败硬塞进某一类，
 * 等于把一个 bug 说成一句确定的诊断。
 */
export function readModelRequestErrorReason(error: unknown): ModelRequestErrorReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const reason = (error as { reason?: unknown }).reason
  if (typeof reason !== 'string') return undefined
  return (MODEL_REQUEST_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as ModelRequestErrorReason)
    : undefined
}

/**
 * 响应头已经交出去之后才发生的失败。
 *
 * 单独一个类型是因为它的处理方式和「请求根本没发出去」完全不同：状态码已经写给客户端了，
 * 改不回去，唯一诚实的做法是**断掉连接**（M2 侧 `response.destroy()`），让客户端把这次响应
 * 判成不完整而不是「一次成功但内容被截断」。桌面侧对应的是 `ModelProxyEvent::Error`。
 *
 * 它的 `reason` 恒为 `upstream-failed`：两条文案（响应过大 / 响应中断）都是「这次上游往返没成」。
 * 「响应头有没有交出去」不进 reason——那不是失败的种类，是**发生的时刻**，外壳判它用的是
 * `response.headersSent`，那才是当场就知道的事实。
 */
export class ModelProxyStreamError extends ModelRequestError {
  override readonly name = 'ModelProxyStreamError'

  constructor(message: string) {
    super('upstream-failed', message)
  }
}

/**
 * 这次请求被显式取消了（`cancel_model_provider_request`，或调用方自己的 AbortSignal）。
 *
 * 与桌面侧的形状差异**是刻意的**：Rust 那边取消后 `run_provider_request` 返回 `Ok(())`——它能
 * 这么做是因为响应走的是另一条 Channel，命令本身的返回值没人当结果看。Node 侧响应就是
 * 本函数的返回值，「取消」没有一个能冒充成功的返回值，所以它是 rejection。
 * 调用方（M2）据此断连接，不写任何响应体。
 */
export class ModelRequestCancelledError extends ModelRequestError {
  override readonly name = 'ModelRequestCancelledError'

  constructor() {
    super('cancelled', '模型请求已取消')
  }
}
