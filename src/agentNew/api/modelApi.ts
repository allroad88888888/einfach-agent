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
// 详情：apiKey 必填；baseUrl 覆盖默认接入点；signal 用于中断；fetchImpl 便于测试注入。
export interface ChatCallOptions {
  apiKey: string
  baseUrl?: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

export interface ChatStreamHandlers {
  onDelta?(delta: ModelStreamDelta): void
}

// 简介：底层 OpenAI 兼容 chat/completions 调用（非流式）。
// 详情：deepseek.ts / glm.ts 各自填好 baseUrl 与特化 body 后调它；body 原样序列化
// （含各家特有的 reasoning_effort），仅补 Authorization。!ok 抛 Error 带回服务端
// detail；AbortError 透传。
export async function postChatCompletion(
  baseUrl: string,
  body: ChatRequestBase,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat completion returned ${response.status}${detail ? `: ${detail}` : ''}.`)
  }

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
export async function postChatCompletionStream(
  baseUrl: string,
  body: ChatRequestBase,
  options: ChatCallOptions,
  handlers: ChatStreamHandlers = {},
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: options.signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat completion returned ${response.status}${detail ? `: ${detail}` : ''}.`)
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('text/event-stream') || !response.body) {
    const full = (await response.json()) as ModelChatResponse
    emitFullResponseAsDelta(full, handlers)
    return full
  }

  return readStreamResponse(response.body, handlers)
}
