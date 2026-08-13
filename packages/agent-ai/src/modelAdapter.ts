// 运行时模型路由：把通用请求经 provider registry 分发给对应 adapter。
// ---------------------------------------------------------------------------
// 这里不再有按 vendor 的 if 链，也不认识任何厂商私有字段：vendorId 交给
// defaultProviderRegistry 解析，请求投影由各家 adapter 自己做（见 ./builtinProviders）。

import { defaultProviderRegistry } from './builtinProviders'
import type { DeepSeekReasoningEffort } from './deepseek'
import type { GlmReasoningEffort } from './glm'
import type { KimiRegion } from './kimiRegion'
import type {
  ChatCallOptions,
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
  ModelRetryObserver,
} from './modelApi'
import type { ProviderAdapter, ProviderRequest } from './providerRegistry'

export type ModelAdapterSettings =
  | { vendor: 'deepseek'; reasoning_effort?: DeepSeekReasoningEffort }
  | { vendor: 'glm'; reasoning_effort?: GlmReasoningEffort }
  | { vendor: 'kimi'; region?: KimiRegion }
  // baseUrl 必填才能真正发出请求，但类型上留成可选：装配层可以在注册 adapter 时烘焙默认
  // 接入点（见 builtinProviders.createOpenAiCompatAdapter），未提供时才需要靠这里补。
  | { vendor: 'openai-compat'; baseUrl?: string }

export interface ModelRequest extends ChatRequestBase {
  settings: ModelAdapterSettings
  userId?: string
}

/** @deprecated Prefer ModelAdapterSettings for requests that may be non-streaming. */
export type ModelStreamSettings = ModelAdapterSettings

/** @deprecated Prefer ModelRequest for requests that may be non-streaming. */
export type ModelStreamRequest = ModelRequest

interface DispatchedRequest {
  adapter: ProviderAdapter
  request: ProviderRequest<ModelAdapterSettings>
}

// 简介：解析 vendorId 并拆出 provider-neutral 请求体。
// 详情：settings/userId 从线协议请求体里剥离，只作为 adapter 的投影输入；未注册的
// vendorId 由 registry 回退到 DeepSeek，只有连回退目标都被取消注册才会抛错。
function dispatch(request: ModelRequest): DispatchedRequest {
  const { settings, userId, ...body } = request
  const adapter = defaultProviderRegistry.resolve(settings.vendor)
  if (adapter === undefined) {
    throw new Error(`No provider adapter registered for vendor ${settings.vendor}.`)
  }
  return { adapter, request: { body, settings, userId } }
}

/** Calls a generic runtime request through its provider adapter. */
export function callModel(
  request: ModelRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const dispatched = dispatch(request)
  return dispatched.adapter.call(dispatched.request, options)
}

/** Streams a generic runtime request through its provider adapter. */
export function streamModel(
  request: ModelRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
  retryObserver?: ModelRetryObserver,
): Promise<ModelChatResponse> {
  const dispatched = dispatch(request)
  return dispatched.adapter.stream(dispatched.request, options, handlers, retryObserver)
}
