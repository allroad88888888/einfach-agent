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
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'

// 简介：DeepSeek 的推理投入档位。
// 详情：到 'high' 为止 —— 这是和 GLM 的“参数不一样”之一（GLM-5.2 还支持 'max'）。
export type DeepSeekReasoningEffort = 'low' | 'medium' | 'high'

// 简介：发给 DeepSeek 的请求体。
// 详情：公共字段来自 ChatRequestBase，仅 reasoning_effort 取值域为 DeepSeek 特化。
export interface DeepSeekChatRequest extends ChatRequestBase {
  reasoning_effort?: DeepSeekReasoningEffort
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
  return postChatCompletion(options.baseUrl ?? DEEPSEEK_BASE_URL, body, options)
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
    withStreamUsage(body),
    options,
    handlers,
  )
}
