// 运行时模型路由：把通用请求投影为 provider adapter 的特化请求。

import {
  streamDeepSeek,
  type DeepSeekReasoningEffort,
} from './deepseek'
import { streamGlm, type GlmReasoningEffort } from './glm'
import type {
  ChatCallOptions,
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
  ModelRetryObserver,
} from './modelApi'

export type ModelStreamSettings =
  | { vendor: 'deepseek'; reasoning_effort?: DeepSeekReasoningEffort }
  | { vendor: 'glm'; reasoning_effort?: GlmReasoningEffort }

export interface ModelStreamRequest extends ChatRequestBase {
  settings: ModelStreamSettings
  userId?: string
}

/** Streams a generic runtime request through its provider adapter. */
export function streamModel(
  request: ModelStreamRequest,
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
