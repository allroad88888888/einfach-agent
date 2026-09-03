// GLM（智谱）的接口调用。
// ---------------------------------------------------------------------------
// 共享线协议类型与底层 postChatCompletion 在 ./modelApi；这里只放 GLM 的请求特化
// 与调用入口。GLM-5.3 系列是 OpenAI 兼容接口，支持 thinking /
// reasoning_effort / function calling（见 docs.bigmodel.cn/cn/guide/models/text/glm-5.3）。

import {
  postChatCompletion,
  postChatCompletionStream,
  type ChatCallOptions,
  type ChatStreamHandlers,
  type ChatRequestBase,
  type ModelChatResponse,
} from './modelApi'
import { nonVisualMessages } from './nonVisualMessages'
import { GLM_BASE_URL } from './providerOrigins'

// 简介：GLM 接入点与默认模型。
export { GLM_BASE_URL } from './providerOrigins'
export const GLM_PRO_MODEL = 'glm-5.3'
export const GLM_FLASH_MODEL = 'glm-5.3-flash'
export const DEFAULT_GLM_MODEL = GLM_PRO_MODEL

// 简介：GLM 的推理投入档位。
// 详情：GLM-5.3 与 GLM-5.3-Flash 只接受 low/high/max。
export type GlmReasoningEffort = 'low' | 'high' | 'max'

// 简介：发给 GLM 的请求体。
// 详情：公共字段来自 ChatRequestBase，仅 reasoning_effort 取值域为 GLM 特化。
export interface GlmChatRequest extends ChatRequestBase {
  reasoning_effort?: GlmReasoningEffort
}

function prepareGlmRequest(body: GlmChatRequest): GlmChatRequest {
  const messages = nonVisualMessages(body.messages)
  return messages === body.messages ? body : { ...body, messages }
}

// 简介：调用 GLM 的 chat/completions（一次性完整响应）。
// 详情：默认接入 GLM_BASE_URL，可由 options.baseUrl 覆盖。
export function callGlm(
  body: GlmChatRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  return postChatCompletion(options.baseUrl ?? GLM_BASE_URL, prepareGlmRequest(body), options)
}

// 简介：调用 GLM 的 chat/completions（流式）。
// 详情：delta 通过 handlers.onDelta 增量回调，最终仍 resolve 为完整 ModelChatResponse。
// GLM 会在流末自动返回 usage，官方未声明需要 stream_options.include_usage，故这里不额外注入。
export function streamGlm(
  body: GlmChatRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  return postChatCompletionStream(
    options.baseUrl ?? GLM_BASE_URL,
    prepareGlmRequest(body),
    options,
    handlers,
  )
}
