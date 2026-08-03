// 运行时模型路由：把通用请求投影为 provider adapter 的特化请求。

import {
  callDeepSeek,
  streamDeepSeek,
  type DeepSeekReasoningEffort,
} from './deepseek'
import { callGlm, streamGlm, type GlmReasoningEffort } from './glm'
import type {
  ChatCallOptions,
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
  ModelRetryObserver,
} from './modelApi'

export type ModelAdapterSettings =
  | { vendor: 'deepseek'; reasoning_effort?: DeepSeekReasoningEffort }
  | { vendor: 'glm'; reasoning_effort?: GlmReasoningEffort }

export interface ModelRequest extends ChatRequestBase {
  settings: ModelAdapterSettings
  userId?: string
}

/** @deprecated Prefer ModelAdapterSettings for requests that may be non-streaming. */
export type ModelStreamSettings = ModelAdapterSettings

/** @deprecated Prefer ModelRequest for requests that may be non-streaming. */
export type ModelStreamRequest = ModelRequest

/** Calls a generic runtime request through its provider adapter. */
export function callModel(
  request: ModelRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const { settings, userId, ...body } = request
  if (settings.vendor === 'glm') {
    return callGlm({ ...body, reasoning_effort: settings.reasoning_effort }, options)
  }
  return callDeepSeek(
    { ...body, reasoning_effort: settings.reasoning_effort, user_id: userId },
    options,
  )
}

/** Streams a generic runtime request through its provider adapter. */
export function streamModel(
  request: ModelRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
  retryObserver?: ModelRetryObserver,
): Promise<ModelChatResponse> {
  const { settings, userId, ...body } = request
  if (settings.vendor === 'glm') {
    return streamGlm({ ...body, reasoning_effort: settings.reasoning_effort }, options, handlers)
  }
  return streamDeepSeek(
    { ...body, reasoning_effort: settings.reasoning_effort, user_id: userId },
    options,
    handlers,
    retryObserver,
  )
}
