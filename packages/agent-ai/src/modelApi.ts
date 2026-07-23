// 和 model 通信的「共享线协议类型」+ 底层调用。
// ---------------------------------------------------------------------------
// 两个 provider（DeepSeek / GLM）都是 OpenAI 兼容的 chat/completions，公共部分都在这：
//   · 消息条目（messages 里的元素）、工具定义、tool_choice、thinking、响应结构；
//   · 请求体公共子集 ChatRequestBase（各家特有字段在各自文件里 extends）；
//   · 底层 postChatCompletion / postChatCompletionStream。
// 各 provider 的请求特化与调用入口分文件：deepseek.ts / glm.ts。
// 字段名一律用线上 snake_case，类型即 payload。

// ===========================================================================
// 一、消息条目（messages 里的元素，请求侧）
// ===========================================================================

// 简介：消息条目的角色。
// 详情：比产品侧 ChatRole（user/assistant/system）多一个 'tool' —— 工具结果回填给模型时用。
export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

// 简介：assistant 发起的一次 function 工具调用。
// 详情：arguments 是“JSON 字符串”而非对象（线上协议如此），收到后需 JSON.parse 才是参数对象。
export interface ModelToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// 简介：system 指令条目。
export interface SystemItem {
  role: 'system'
  content: string
}

// 简介：user 输入条目。
export interface UserItem {
  role: 'user'
  content: string
}

// 简介：assistant 回复条目。
// 详情：content 可为 null（纯工具调用轮）；reasoning_content 是思维链回填，可选；
// 带 tool_calls 时表示本轮模型选择调用工具，需在后续 ToolItem 里按 id 回填结果。
export interface AssistantItem {
  role: 'assistant'
  content: string | null
  reasoning_content?: string | null
  tool_calls?: ModelToolCall[]
}

// 简介：工具结果回填条目。
// 详情：tool_call_id 必须精确匹配上一条 AssistantItem.tool_calls[].id；content 是工具
// 执行结果（通常是 JSON 字符串），模型据此继续下一轮。
export interface ToolItem {
  role: 'tool'
  tool_call_id: string
  content: string
}

// 简介：messages 数组里的一条 —— 发给 model 的最小单位。
// 详情：四种角色的判别联合，按 role 收窄；这就是请求体 `messages: ModelItem[]`。
export type ModelItem = SystemItem | UserItem | AssistantItem | ToolItem

// ===========================================================================
// 二、工具与公共配置（请求侧）
// ===========================================================================

// 简介：暴露给模型的 function 工具定义。
// 详情：放进请求体 `tools` 字段。parameters 是该工具的 JSON Schema（懒加载后才填）；
// 未加载 schema 的工具不进这里，只通过 request_tool_schema 间接请求。
export interface ModelFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

// 简介：工具选择策略。
// 详情：'auto' 让模型自行决定是否调工具；'none' 禁用；'required' 强制至少一次；也可点名某个 function。
export type ModelToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

// 简介：思维链开关（两家通用）。
// 详情：DeepSeek / GLM-5.2 都用 `thinking: { type: 'enabled' }` 打开 reasoning_content 回流。
export interface ThinkingConfig {
  type: 'enabled' | 'disabled'
}

// ===========================================================================
// 三、请求体公共子集（各 provider 在各自文件 extends 这个）
// ===========================================================================

// 简介：两家共用的请求字段（OpenAI 兼容公共子集）。
// 详情：非流式调用不传 stream；流式调用由 postChatCompletionStream 强制补 `stream:true`。
// reasoning_effort 因取值域各家不同，不在这里，放各自的 *ChatRequest。
export interface ChatRequestBase {
  model: string
  messages: ModelItem[]
  tools?: ModelFunctionTool[]
  tool_choice?: ModelToolChoice
  thinking?: ThinkingConfig
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

// ===========================================================================
// 四、响应体（两家一致的完整响应结构）
// ===========================================================================
// 注意：响应侧字段几乎全为可选 —— 服务端给的、可能缺字段、要容错，故不复用上面的
// AssistantItem/ModelToolCall（那是请求侧必填版），另立宽松版本；解析成功后才收窄。

// 简介：模型本轮的停止原因。
// 详情：'tool_calls' = 模型要调工具；'stop' = 正常结束；'length' = 触顶；
// 'insufficient_system_resource' 是 DeepSeek 特有的容量降级原因。
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'insufficient_system_resource'

// 简介：响应里 assistant message 中的一次工具调用（宽松版）。
export interface ModelResponseToolCall {
  index?: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

// 简介：响应里的 assistant message（宽松版）。
// 详情：解析后对应请求侧 AssistantItem；content 可能为 null/缺失（纯工具调用轮）。
export interface ModelResponseMessage {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ModelResponseToolCall[]
}

// 简介：stream 响应里 choices[0].delta 的宽松形状。
export interface ModelStreamDelta {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ModelResponseToolCall[]
}

export interface ModelStreamChoice {
  delta?: ModelStreamDelta
  finish_reason?: FinishReason | null
}

export interface ModelChatStreamChunk {
  choices?: ModelStreamChoice[]
}

// 简介：响应里的一个候选。
export interface ModelResponseChoice {
  finish_reason?: FinishReason | null
  message?: ModelResponseMessage
}

export interface ModelUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

// 简介：chat/completions 完整响应体（非流式响应，或流式累计后的最终形状，两家共用）。
// 详情：通常只取 choices[0].message。
export interface ModelChatResponse {
  id?: string
  model?: string
  usage?: ModelUsage
  choices?: ModelResponseChoice[]
}

// ===========================================================================
// 五、底层调用（DeepSeek / GLM 共用）
// ===========================================================================

type FetchLike = typeof fetch

// 简介：一次接口调用的旁路参数（不进请求体的东西）。
// 详情：apiKey 必填；baseUrl 覆盖默认接入点；signal 用于中断；fetchImpl 便于测试注入；
// retry 覆盖默认退避策略（不传即用 DEFAULT_RETRY_CONFIG）。
export interface ChatCallOptions {
  apiKey: string
  baseUrl?: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  retry?: RetryConfig
}

export interface ChatStreamHandlers {
  onDelta?(delta: ModelStreamDelta): void
}

// ===========================================================================
// 五之一、重试（429 / 5xx / 网络抖动的指数退避）
// ===========================================================================
// 背景：上层 modelRun 的失败降级很粗暴 —— 底层一抛错，整条 run 就 status='error'，
// 用户得重发整轮。而 429（限流）和 5xx（服务端抖动）绝大多数是瞬时的，退避几百毫秒
// 重发就能救回来，所以在底层这一层兜住，两家 provider（deepseek.ts / glm.ts 只是
// 转发到这两个函数）同时受益。
//
// 不变量（改动前务必先读）：
//   R1 AbortError 永不重试，且必须原样透传 —— 上层靠
//      `err instanceof DOMException && err.name === 'AbortError'` 把 run 降级成
//      'stopped'。退避等待期间同样监听 signal，被中断就立刻抛 AbortError。
//   R2 只重试 429 / 5xx / fetch 自身抛出的网络错误。其它 4xx（401 鉴权、400 参数）
//      是确定性失败，重试只是白烧时间和额度。
//   R3 流式只有「尚未 emit 任何有实际内容的 delta」时才允许重试。详见 postChatCompletionStream。

// 简介：重试策略配置（都可选，缺省见 DEFAULT_RETRY_CONFIG）。
// 详情：sleepImpl 是给测试注入的 —— 测试注入一个立刻 resolve 的实现，就不会真的等。
export interface RetryConfig {
  // 最多重试几次（不含首次请求）。0 = 关闭重试。
  maxRetries?: number
  // 第一次退避的基准毫秒数，之后按 2 的幂增长。
  baseDelayMs?: number
  // 单次退避上限（也用来钳住服务端给的 Retry-After，避免一个 300s 的头把 agent 挂死）。
  maxDelayMs?: number
  // 是否加抖动（默认加；测试里关掉可得到确定性延迟）。
  jitter?: boolean
  // 等待实现，便于测试注入。
  sleepImpl?(ms: number, signal?: AbortSignal): Promise<void>
  // 每次决定重试时回调一次，便于上层埋点/日志。
  onRetry?(info: RetryAttemptInfo): void
}

// 简介：一次重试决策的描述（onRetry 的入参）。
export interface RetryAttemptInfo {
  // 第几次重试，从 1 开始。
  attempt: number
  // 本次实际等待的毫秒数。
  delayMs: number
  // 触发重试的原因（HTTP 状态或网络错误消息）。
  reason: string
  // 触发重试的原始错误（网络错误时是 fetch 抛出的那个）。
  error: unknown
}

// 简介：默认重试策略。
// 详情：3 次重试 + 500ms 基准 ⇒ 最坏等待约 0.5s + 1s + 2s，对交互式 agent 可接受。
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: true,
} as const

interface ResolvedRetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitter: boolean
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  onRetry?(info: RetryAttemptInfo): void
}

function resolveRetryConfig(config?: RetryConfig): ResolvedRetryConfig {
  return {
    maxRetries: Math.max(0, config?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries),
    baseDelayMs: Math.max(0, config?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs),
    maxDelayMs: Math.max(0, config?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs),
    jitter: config?.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
    sleep: config?.sleepImpl ?? defaultSleep,
    onRetry: config?.onRetry,
  }
}

// 简介：判断是否为「中断」错误（R1）。
// 详情：故意按 name 鸭子类型判断，不写 `err instanceof Error` —— 中断错误标准形态是
// DOMException('AbortError')，而 **DOMException 并不总是 Error 的实例**（jsdom / Node 下
// `new DOMException() instanceof Error === false`，浏览器里才是 true）。用 instanceof Error
// 会让 abort 在测试环境被误判成「网络抖动」而进入重试，直接破坏 R1。
// 另有部分 fetch polyfill（Tauri / node-fetch）只给一个 name='AbortError' 的普通 Error，
// 鸭子类型同样覆盖。
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  )
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

// 简介：可被 signal 打断的等待（R1）。
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError())
  if (ms <= 0) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 简介：哪些 HTTP 状态值得重试（R2）。
// 详情：429 = 限流；>=500 = 服务端侧故障。其余 4xx 是我们自己请求的问题，重发没意义。
function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function readHeader(response: Response, name: string): string | null {
  try {
    return response.headers.get(name)
  } catch {
    // 测试/polyfill 里可能压根没有 headers，缺就当没给。
    return null
  }
}

// 简介：解析 Retry-After 头，返回建议等待毫秒数。
// 详情：两种合法形式 —— 秒数（"12"、"1.5"）或 HTTP-date（"Wed, 21 Oct 2015 07:28:00 GMT"）。
// 解析不出来返回 undefined，退回指数退避。
function parseRetryAfterMs(raw: string | null, nowMs: number = Date.now()): number | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  if (!value) return undefined

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined
  }

  const targetMs = Date.parse(value)
  if (Number.isNaN(targetMs)) return undefined
  return Math.max(0, targetMs - nowMs)
}

// 简介：算出第 attempt 次失败后应该等多久（attempt 从 0 开始）。
// 详情：服务端给了 Retry-After 就优先尊重（钳到 maxDelayMs）；否则 base * 2^attempt 封顶
// maxDelayMs，再叠等量抖动（一半固定一半随机）—— 防止多个并发请求同时重发，把刚缓过来的
// 服务端二次打垮。
function computeBackoffMs(
  attempt: number,
  config: ResolvedRetryConfig,
  retryAfterMs?: number,
): number {
  // Retry-After 可能是 0（服务端明确说“立刻重试即可”）或者一个已经过期的 HTTP-date
  // （parseRetryAfterMs 会算出 0 甚至更小，已被钳到 0）。这两种情况如果直接照抄，
  // 就会在正被限流的服务端上零间隔连打，等于把 retry 又变成了没有退避的重发。
  // 所以下限钳到 baseDelayMs —— 服务端说的时间更长就听服务端的，更短也至少退避一个基准间隔。
  if (typeof retryAfterMs === 'number') {
    return Math.min(Math.max(retryAfterMs, config.baseDelayMs), config.maxDelayMs)
  }

  const exponential = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs)
  if (!config.jitter) return exponential
  return Math.round(exponential / 2 + Math.random() * (exponential / 2))
}

// 简介：内部标记类 —— 「这次失败可以重试」。
// 详情：只在本文件内流转；重试次数耗尽时对外抛的是 originalError（网络错误保留原样）
// 或它自己（HTTP 错误，message 已经带上服务端 detail）。
class RetriableError extends Error {
  readonly retryAfterMs?: number
  readonly originalError?: unknown

  constructor(message: string, init: { retryAfterMs?: number; originalError?: unknown } = {}) {
    super(message)
    this.name = 'RetriableError'
    this.retryAfterMs = init.retryAfterMs
    this.originalError = init.originalError
  }
}

// 简介：通用重试执行器。
// 详情：run 抛 RetriableError → 退避后重跑；抛别的 → 立即透传（含 AbortError，R1）。
async function withRetry<T>(
  config: ResolvedRetryConfig,
  signal: AbortSignal | undefined,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt)
    } catch (err) {
      if (isAbortError(err)) throw err
      if (!(err instanceof RetriableError)) throw err
      if (attempt >= config.maxRetries) throw err.originalError ?? err

      const delayMs = computeBackoffMs(attempt, config, err.retryAfterMs)
      config.onRetry?.({
        attempt: attempt + 1,
        delayMs,
        reason: err.message,
        error: err.originalError ?? err,
      })
      await config.sleep(delayMs, signal)
    }
  }
}

// 简介：发一次请求并把「连接阶段」的失败翻译成可重试/不可重试。
// 详情：返回的 Response 一定是 ok 的（body 还没读）。fetch 抛错（网络层）与 429/5xx
// 都包成 RetriableError；其它 4xx 直接抛普通 Error 终结。
async function requestOnce(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (err) {
    if (isAbortError(err)) throw err // R1
    // fetch 只在网络层出问题时 reject（DNS / 断网 / 连接被重置），正是要重试的场景。
    throw new RetriableError(err instanceof Error ? err.message : String(err), {
      originalError: err,
    })
  }

  if (response.ok) return response

  const detail = await response.text().catch(() => '')
  const message = `Chat completion returned ${response.status}${detail ? `: ${detail}` : ''}.`
  if (isRetriableStatus(response.status)) {
    throw new RetriableError(message, {
      retryAfterMs: parseRetryAfterMs(readHeader(response, 'Retry-After')),
    })
  }
  throw new Error(message)
}

function buildRequestInit(body: unknown, options: ChatCallOptions): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

// 简介：底层 OpenAI 兼容 chat/completions 调用（非流式）。
// 详情：deepseek.ts / glm.ts 各自填好 baseUrl 与特化 body 后调它；body 原样序列化
// （含各家特有的 reasoning_effort），仅补 Authorization。429/5xx/网络抖动按
// options.retry 指数退避重试；其它 !ok 抛 Error 带回服务端 detail；AbortError 透传。
// 非流式没有任何增量输出，重发对上层完全透明，所以整个连接阶段都可以放心重试。
// 注意 json() 解析故意放在重试之外 —— SyntaxError 是确定性失败，重试没有意义。
export async function postChatCompletion(
  baseUrl: string,
  body: ChatRequestBase,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  const url = chatCompletionsUrl(baseUrl)
  const init = buildRequestInit(body, options)

  const response = await withRetry(config, options.signal, () => requestOnce(fetchImpl, url, init))

  return (await response.json()) as ModelChatResponse
}

interface StreamAccumulator {
  content: string
  reasoningContent: string
  toolCalls: Map<number, ModelResponseToolCall>
  finishReason?: FinishReason | null
}

function appendToolCallDelta(
  toolCalls: StreamAccumulator['toolCalls'],
  delta: ModelResponseToolCall,
  fallbackIndex: number,
): void {
  const index = typeof delta.index === 'number' ? delta.index : fallbackIndex
  const current = toolCalls.get(index) ?? {
    index,
    type: 'function' as const,
    function: { arguments: '' },
  }

  if (delta.id) current.id = delta.id
  if (delta.type) current.type = delta.type
  if (delta.function) {
    const currentFunction = current.function ?? {}
    if (typeof delta.function.name === 'string') currentFunction.name = delta.function.name
    if (typeof delta.function.arguments === 'string') {
      currentFunction.arguments = `${currentFunction.arguments ?? ''}${delta.function.arguments}`
    }
    current.function = currentFunction
  }

  toolCalls.set(index, current)
}

function applyStreamDelta(acc: StreamAccumulator, delta: ModelStreamDelta): void {
  if (typeof delta.content === 'string') acc.content += delta.content
  if (typeof delta.reasoning_content === 'string') acc.reasoningContent += delta.reasoning_content

  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((toolCall, index) => appendToolCallDelta(acc.toolCalls, toolCall, index))
  }
}

function toChatResponse(acc: StreamAccumulator): ModelChatResponse {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall)
  const message: ModelResponseMessage = {
    role: 'assistant',
    content: acc.content.length > 0 ? acc.content : null,
  }

  if (acc.reasoningContent.length > 0) {
    message.reasoning_content = acc.reasoningContent
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return {
    choices: [
      {
        finish_reason: acc.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        message,
      },
    ],
  }
}

function emitFullResponseAsDelta(response: ModelChatResponse, handlers?: ChatStreamHandlers): void {
  const message = response.choices?.[0]?.message
  if (!message) return
  handlers?.onDelta?.({
    content: message.content,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls,
  })
}

// 简介：判断一个 delta 是否真的携带了「会在界面上留下痕迹」的增量内容（R3 判据）。
// 详情：OpenAI 兼容流的第一个 chunk 恒为 `{"role":"assistant","content":""}` —— 这是个
// 真值对象，但 content 是空字符串，界面不会渲染出任何东西。只看 `if (delta)` 会把这种
// 首包也算作"已 emit"，导致 R3 想保护的第二条场景（连上了但一个字都没吐就断流）实际上
// 永远触发不了。这里改成只在 content/reasoning_content 有非空字符串，或 tool_calls
// 数组非空时才算「真的吐过东西」。
function deltaCarriesContent(delta: ModelStreamDelta): boolean {
  if (typeof delta.content === 'string' && delta.content.length > 0) return true
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
  return false
}

function eventDataFromSseBlock(block: string): string | undefined {
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined
}

function consumeSseBuffer(
  buffer: string,
  acc: StreamAccumulator,
  handlers?: ChatStreamHandlers,
): { rest: string; done: boolean } {
  let rest = buffer.replace(/\r\n/g, '\n')

  while (true) {
    const boundary = rest.indexOf('\n\n')
    if (boundary < 0) return { rest, done: false }

    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const data = eventDataFromSseBlock(block)
    if (!data) continue
    if (data === '[DONE]') return { rest, done: true }

    const chunk = JSON.parse(data) as ModelChatStreamChunk
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      handlers?.onDelta?.(delta)
      applyStreamDelta(acc, delta)
    }
    if (choice?.finish_reason) {
      acc.finishReason = choice.finish_reason
    }
  }
}

async function readStreamResponse(
  body: ReadableStream<Uint8Array>,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const acc: StreamAccumulator = { content: '', reasoningContent: '', toolCalls: new Map() }
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const consumed = consumeSseBuffer(buffer, acc, handlers)
      buffer = consumed.rest
      if (consumed.done) break
      if (done) {
        const trailing = buffer.trim()
        if (trailing) {
          const consumedTrailing = consumeSseBuffer(`${buffer}\n\n`, acc, handlers)
          buffer = consumedTrailing.rest
        }
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  return toChatResponse(acc)
}

// 简介：底层 OpenAI 兼容 chat/completions 流式调用。
// 详情：请求体强制 `stream:true`；SSE delta 通过 handlers.onDelta 增量上报，同时函数最终
// resolve 成与非流式相同的 ModelChatResponse，供 tool loop 复用原有分支。
//
// ★ R3 —— 流式重试的唯一不变量：只有「尚未 emit 过任何有实际内容的 delta」时才允许重试。★
// 原因：onDelta 是**单向增量**的 —— 上层 streamWriter 收到一个 delta 就直接往界面上追加
// 文字，没有任何回滚手段。一旦已经吐过字，重发请求会让模型从头再生成一遍，这些新 delta
// 会继续追加在旧内容后面，用户看到的就是同一段话重复两次。所以：
//   · 连接阶段失败（fetch 抛错 / 响应 !ok，body 还一个字都没读）→ 安全，可重试；
//   · 读流阶段失败但 emitted 仍为 false（连上了却没吐出任何有内容的 delta 就断了）→ 安全，可重试；
//   · 只要 emitted 已为 true → 一律把错误抛给上层，绝不重试。
// emitted 标志由下面的 guardedHandlers 维护，依据是 deltaCarriesContent（严格判断
// content/reasoning_content/tool_calls 是否真的有内容，而不是「delta 对象存在与否」——
// 首包恒为 `{content:""}`，若按对象存在与否判断，这条不变量在生产环境永远不会真正生效），
// 且**跨重试累积**（一旦为 true 就永不回落）。改这段代码前请先想清楚会不会破坏它。
export async function postChatCompletionStream(
  baseUrl: string,
  body: ChatRequestBase,
  options: ChatCallOptions,
  handlers: ChatStreamHandlers = {},
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  const url = chatCompletionsUrl(baseUrl)
  const init = buildRequestInit({ ...body, stream: true }, options)

  // 只要透传出去过一个「有内容」的 delta，emitted 就永久为 true —— 之后任何失败都不再重试。
  // 注意：即使 emitted 还是 false，delta 依然会原样透传给 handlers —— 空 delta 对界面
  // 没有可见影响（createAssistantStreamWriter.flush() 在 content.trim() 非空前不会建条目），
  // 这里只是不把它计入「已经吐过字」。
  let emitted = false
  const guardedHandlers: ChatStreamHandlers = {
    onDelta(delta) {
      if (deltaCarriesContent(delta)) emitted = true
      handlers.onDelta?.(delta)
    },
  }

  return withRetry(config, options.signal, async () => {
    // 连接阶段：还没碰 body，失败可安全重试（requestOnce 内部已按 R2 分类）。
    const response = await requestOnce(fetchImpl, url, init)

    const contentType = readHeader(response, 'Content-Type') ?? ''
    if (!contentType.includes('text/event-stream') || !response.body) {
      // 非流式回退分支：与 postChatCompletion 保持一致 —— json() 解析故意放在下面的
      // try/catch 之外。SyntaxError（网关错误页、坏 JSON 等）是确定性失败，重试没有
      // 意义，只会让用户白等几秒、白烧几次请求换一个必然还是失败的结果。
      const full = (await response.json()) as ModelChatResponse
      emitFullResponseAsDelta(full, guardedHandlers)
      return full
    }

    try {
      return await readStreamResponse(response.body, guardedHandlers)
    } catch (err) {
      if (isAbortError(err)) throw err // R1
      // R3：已经吐过有内容的字 → 重试会在 UI 上产生重复内容，只能把错误抛给上层。
      if (emitted) throw err
      // 一个字都没吐出去（多半是连上后 body 就断了）→ 重发是安全的。
      throw new RetriableError(err instanceof Error ? err.message : String(err), {
        originalError: err,
      })
    }
  })
}
