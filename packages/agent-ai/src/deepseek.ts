// DeepSeek 的接口调用。
// ---------------------------------------------------------------------------
// 共享线协议类型与底层 postChatCompletion 在 ./modelApi；这里只放 DeepSeek 的请求
// 特化与调用入口。

import {
  postChatCompletion,
  postChatCompletionStream,
  type ChatCallOptions,
  type ChatStreamHandlers,
  type ChatRequestBase,
  type ModelChatResponse,
} from './modelApi'

// 简介：DeepSeek 接入点与默认模型。
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro'
export const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash'
export const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_PRO_MODEL
export const MAX_DEEPSEEK_USER_ID_LENGTH = 512

// 简介：校验 DeepSeek 官方 user_id 线协议约束。
// 详情：不 trim、不截断——任何超长或带其它字符的值都整体拒绝，避免把邮箱、文件路径等
// 隐私数据“修剪”成另一个仍会被发送的标识。调用方应只传本地生成的不透明随机 ID。
export function normalizeDeepSeekUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_DEEPSEEK_USER_ID_LENGTH) return undefined
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}

// 简介：DeepSeek V4 的推理投入档位。
// 详情：V4 只接受 high / max；旧的 low / medium 最终也只会被服务端映射成 high。
export type DeepSeekReasoningEffort = 'high' | 'max'

// 简介：发给 DeepSeek 的请求体。
// 详情：公共字段来自 ChatRequestBase，仅 reasoning_effort 取值域为 DeepSeek 特化。
export interface DeepSeekChatRequest extends ChatRequestBase {
  reasoning_effort?: DeepSeekReasoningEffort
  user_id?: string
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
}

// 简介：规范化 DeepSeek V4 thinking 工具调用历史。
// 详情：官方协议要求工具调用续轮完整回传 assistant 的 reasoning_content；同时工具调用
// assistant 的 content 不能为 null。这里只把纯工具调用轮的 null 规范为空字符串，不修改
// 调用方原始 messages。
function prepareDeepSeekThinkingMessages(
  messages: DeepSeekChatRequest['messages'],
): DeepSeekChatRequest['messages'] {
  return messages.map((message) => (
    message.role === 'assistant'
      && message.content === null
      && (message.tool_calls?.length ?? 0) > 0
      ? { ...message, content: '' }
      : message
  ))
}

// 简介：按 DeepSeek V4 thinking 协议净化请求。
// 详情：thinking 开启时，DeepSeek 不支持四个采样参数，也不接受 tool_choice。调用方的
// 会话设置仍需保留，因此这里只创建一个兼容的新对象，不修改传入 body。
function prepareDeepSeekRequest(body: DeepSeekChatRequest): DeepSeekChatRequest {
  const {
    user_id: rawUserId,
    tool_choice: rawToolChoice,
    temperature: _temperature,
    top_p: _topP,
    presence_penalty: _presencePenalty,
    frequency_penalty: _frequencyPenalty,
    ...baseRequest
  } = body
  const userId = normalizeDeepSeekUserId(rawUserId)
  const request = userId === undefined ? baseRequest : { ...baseRequest, user_id: userId }

  if (body.thinking?.type === 'enabled') {
    return {
      ...request,
      messages: prepareDeepSeekThinkingMessages(body.messages),
    }
  }

  return {
    ...request,
    tool_choice: rawToolChoice,
    temperature: body.temperature,
    top_p: body.top_p,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
  }
}

function withStreamUsage(body: DeepSeekChatRequest): DeepSeekChatRequest {
  return {
    ...body,
    stream_options: {
      ...body.stream_options,
      // DeepSeek 只有 include_usage=true 才在 [DONE] 前补发最终 usage chunk。
      // 尊重调用方显式关闭；未指定时默认打开，保证缓存命中统计可见。
      include_usage: body.stream_options?.include_usage ?? true,
    },
  }
}

// 简介：调用 DeepSeek 的 chat/completions（一次性完整响应）。
// 详情：默认接入 DEEPSEEK_BASE_URL，可由 options.baseUrl 覆盖。
export function callDeepSeek(
  body: DeepSeekChatRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  return postChatCompletion(
    options.baseUrl ?? DEEPSEEK_BASE_URL,
    prepareDeepSeekRequest(body),
    options,
  )
}

// 简介：调用 DeepSeek 的 chat/completions（流式）。
// 详情：delta 通过 handlers.onDelta 增量回调，最终仍 resolve 为完整 ModelChatResponse。
export function streamDeepSeek(
  body: DeepSeekChatRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  return postChatCompletionStream(
    options.baseUrl ?? DEEPSEEK_BASE_URL,
    withStreamUsage(prepareDeepSeekRequest(body)),
    options,
    handlers,
  )
}
