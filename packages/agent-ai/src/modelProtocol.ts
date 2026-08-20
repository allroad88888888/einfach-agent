/** Provider-neutral request items shared by the OpenAI-compatible adapters. */
export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface SystemItem {
  role: 'system'
  content: string
}

export interface ProviderFileImageSource {
  kind: 'provider-file'
  provider: string
  scope: string
  reference: string
}

export interface UserTextContentBlock {
  type: 'text'
  text: string
}

export interface UserImageContentBlock {
  type: 'image'
  source: ProviderFileImageSource
  name: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
}

export type UserContentBlock = UserTextContentBlock | UserImageContentBlock
export type UserMessageContent = string | readonly UserContentBlock[]

export interface UserItem {
  role: 'user'
  content: UserMessageContent
}

export interface AssistantItem {
  role: 'assistant'
  content: string | null
  reasoning_content?: string | null
  tool_calls?: ModelToolCall[]
}

export interface ToolItem {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type ModelItem = SystemItem | UserItem | AssistantItem | ToolItem

export interface ModelFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export type ModelToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ThinkingConfig {
  type: 'enabled' | 'disabled'
}

export interface ChatStreamOptions {
  include_usage?: boolean
  [key: string]: unknown
}

export interface ChatRequestBase<TMessage = ModelItem> {
  model: string
  messages: TMessage[]
  tools?: ModelFunctionTool[]
  tool_choice?: ModelToolChoice
  thinking?: ThinkingConfig
  temperature?: number
  max_tokens?: number
  stream?: boolean
  stream_options?: ChatStreamOptions
}

export type FinishReason = string

export interface ModelFinishReasonExtension {
  reason: string
  error: string
  itemNotice: string
  standaloneNotice: string
  /**
   * 这个终态是不是「服务端容量耗尽」——即换一个模型再发一次就可能成功，而不是请求本身有问题。
   * 只有 provider 自己知道自家哪个 finish_reason 是这个意思，所以由注册表自报；消费方
   * （`modelCapacityEscalation`）据此判断值不值得升档，不再比对任何一家的私有字面量。
   */
  capacityExhausted?: boolean
}

export interface ModelResponseToolCall {
  index?: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface ModelResponseMessage {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ModelResponseToolCall[]
}

export interface ModelStreamDelta {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ModelResponseToolCall[]
}

export interface ModelStreamChoice {
  delta?: ModelStreamDelta
  finish_reason?: string | null
}

export interface ModelTokenDetails {
  cached_tokens?: number
  [key: string]: unknown
}

export interface ModelUsage {
  prompt_tokens?: number
  input_tokens?: number
  completion_tokens?: number
  output_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: ModelTokenDetails
  input_tokens_details?: ModelTokenDetails
  cached_tokens?: number
  [key: string]: unknown
}

export interface ModelChatStreamChunk {
  id?: string
  model?: string
  choices?: ModelStreamChoice[]
  usage?: ModelUsage | null
}

export interface ModelResponseChoice {
  finish_reason?: string | null
  message?: ModelResponseMessage
}

export interface ModelChatResponse {
  id?: string
  model?: string
  usage?: ModelUsage
  choices?: ModelResponseChoice[]
}

export interface ModelRetryObserver {
  canRetry?(): boolean
  onRetry?(event: {
    status: 'retrying' | 'recovered' | 'exhausted'
    attempt: number
    maxRetries: number
    response: ModelChatResponse
  }): void
}

export interface ChatStreamHandlers {
  onDelta?(delta: ModelStreamDelta): void
}
