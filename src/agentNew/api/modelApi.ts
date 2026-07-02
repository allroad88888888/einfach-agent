// 和 model 通信的「共享线协议类型」+ 底层非流式调用。
// ---------------------------------------------------------------------------
// 两个 provider（DeepSeek / GLM）都是 OpenAI 兼容的 chat/completions，公共部分都在这：
//   · 消息条目（messages 里的元素）、工具定义、tool_choice、thinking、响应结构；
//   · 请求体公共子集 ChatRequestBase（各家特有字段在各自文件里 extends）；
//   · 底层 postChatCompletion（一次 fetch 拿回完整 ModelChatResponse）。
// 各 provider 的请求特化与调用入口分文件：deepseek.ts / glm.ts。
// 本期固定「非流式」：请求不带 stream，流式留到下一期。
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
// 详情：本期非流式，不含 stream；下一期改流式时在这里加回 `stream?: boolean`。
// reasoning_effort 因取值域各家不同，不在这里，放各自的 *ChatRequest。
export interface ChatRequestBase {
  model: string
  messages: ModelItem[]
  tools?: ModelFunctionTool[]
  tool_choice?: ModelToolChoice
  thinking?: ThinkingConfig
  temperature?: number
  max_tokens?: number
}

// ===========================================================================
// 四、响应体（两家一致，本期非流式完整结构）
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

// 简介：响应里的一个候选。
export interface ModelResponseChoice {
  finish_reason?: FinishReason | null
  message?: ModelResponseMessage
}

// 简介：chat/completions 完整响应体（非流式，两家共用）。
// 详情：通常只取 choices[0].message。
export interface ModelChatResponse {
  choices?: ModelResponseChoice[]
}

// ===========================================================================
// 五、底层调用（非流式，DeepSeek / GLM 共用）
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
