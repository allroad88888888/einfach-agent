// 内置三家 provider 的装配：把 deepseek/glm/kimi 装进默认 registry。
// ---------------------------------------------------------------------------
// 参照 Rust 侧「装配层显式列举合法」：这里是 adapter 包内唯一允许出现厂商名的地方。
// 每家的私有请求字段都在自己的 adapter 里从通用 ProviderSettings 投影出来，registry 与
// 上层路由（modelAdapter）都不认识这些字段。
// 默认 registry 的 fallback 是 deepseek —— 未注册的 vendorId 沿用历史行为按 DeepSeek 执行。

import {
  callDeepSeek,
  streamDeepSeek,
  type DeepSeekChatRequest,
  type DeepSeekReasoningEffort,
} from './deepseek'
import { callGlm, streamGlm, type GlmChatRequest, type GlmReasoningEffort } from './glm'
import { callKimi, streamKimi, type KimiChatRequest } from './kimi'
import type { KimiRegion } from './kimiRegion'
import {
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderRegistry,
  type ProviderRequest,
  type ProviderSettings,
} from './providerRegistry'

export const DEEPSEEK_VENDOR_ID = 'deepseek'
export const GLM_VENDOR_ID = 'glm'
export const KIMI_VENDOR_ID = 'kimi'

type DeepSeekProviderSettings = ProviderSettings & { reasoning_effort?: DeepSeekReasoningEffort }
type GlmProviderSettings = ProviderSettings & { reasoning_effort?: GlmReasoningEffort }
type KimiProviderSettings = ProviderSettings & { region?: KimiRegion }

// 简介：DeepSeek 的请求投影。
// 详情：DeepSeek 是唯一消费 userId 的厂商（上行为 user_id），并有自己的 reasoning_effort 取值域。
function deepseekRequest(
  request: ProviderRequest<DeepSeekProviderSettings>,
): DeepSeekChatRequest {
  return {
    ...request.body,
    reasoning_effort: request.settings.reasoning_effort,
    user_id: request.userId,
  }
}

// 简介：GLM 的请求投影。
// 详情：只归一 reasoning_effort（取值域比 DeepSeek 多一档）；userId 不上行。
function glmRequest(request: ProviderRequest<GlmProviderSettings>): GlmChatRequest {
  return { ...request.body, reasoning_effort: request.settings.reasoning_effort }
}

// 简介：Kimi 的请求投影。
// 详情：只归一 region（决定接入点与引用 scope）；userId 不上行。
function kimiRequest(request: ProviderRequest<KimiProviderSettings>): KimiChatRequest {
  return { ...request.body, region: request.settings.region }
}

const deepseekAdapter: ProviderAdapter<DeepSeekProviderSettings> = {
  call: (request, options) => callDeepSeek(deepseekRequest(request), options),
  stream: (request, options, handlers, retryObserver) =>
    streamDeepSeek(deepseekRequest(request), options, handlers, retryObserver),
}

const glmAdapter: ProviderAdapter<GlmProviderSettings> = {
  call: (request, options) => callGlm(glmRequest(request), options),
  stream: (request, options, handlers) => streamGlm(glmRequest(request), options, handlers),
}

const kimiAdapter: ProviderAdapter<KimiProviderSettings> = {
  call: (request, options) => callKimi(kimiRequest(request), options),
  stream: (request, options, handlers) => streamKimi(kimiRequest(request), options, handlers),
}

// 简介：把内置三家注册进给定 registry。
// 详情：宿主想要一个只带部分厂商的隔离 registry 时，可以自建实例再选择性注册。
export function registerBuiltinProviders(registry: ProviderRegistry): void {
  registry.register(DEEPSEEK_VENDOR_ID, deepseekAdapter)
  registry.register(GLM_VENDOR_ID, glmAdapter)
  registry.register(KIMI_VENDOR_ID, kimiAdapter)
}

// 简介：默认 provider registry（modelAdapter 的分发表）。
// 详情：模块加载即完成三家注册；fallback 到 DeepSeek 保持未知 vendor 的历史回退语义。
export const defaultProviderRegistry: ProviderRegistry = createProviderRegistry({
  fallbackVendorId: DEEPSEEK_VENDOR_ID,
})

registerBuiltinProviders(defaultProviderRegistry)
