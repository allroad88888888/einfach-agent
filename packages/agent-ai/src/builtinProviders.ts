// 内置三家 provider 的装配：把 deepseek/glm/kimi 连同各自能力描述装进默认 registry。
// ---------------------------------------------------------------------------
// 参照 Rust 侧「装配层显式列举合法」：这里是 adapter 包内唯一允许出现厂商名与厂商能力数据
// （上下文窗口、单轮工具上限、逐模型清单）的地方。每家的私有请求字段都在自己的 adapter 里
// 从通用 ProviderSettings 投影出来，registry 与上层路由（modelAdapter）都不认识这些字段；
// 能力描述同理只在这里出现，vendorDescriptor.ts 只经 registry 查询、不再持有厂商数据。
// 默认 registry 的 fallback 是 deepseek —— 未注册的 vendorId 沿用历史行为按 DeepSeek 执行。
// 新增第四家 provider 只需要在本文件加一段 adapter + descriptor 并注册，其余文件零改动。

import {
  callDeepSeek,
  streamDeepSeek,
  type DeepSeekChatRequest,
  type DeepSeekReasoningEffort,
} from './deepseek'
import { callGlm, streamGlm, type GlmChatRequest, type GlmReasoningEffort } from './glm'
import { KIMI_K2_6_IMAGE_INPUT, UNSUPPORTED_IMAGE_INPUT } from './imageCapability'
import { callKimi, streamKimi, type KimiChatRequest } from './kimi'
import type { KimiRegion } from './kimiRegion'
import {
  createProviderRegistry,
  type ModelDescriptor,
  type ProviderAdapter,
  type ProviderRegistry,
  type ProviderRequest,
  type ProviderSettings,
  type VendorDescriptor,
} from './providerRegistry'

export const DEEPSEEK_VENDOR_ID = 'deepseek'
export const GLM_VENDOR_ID = 'glm'
export const KIMI_VENDOR_ID = 'kimi'

// 简介：构造一个只有文本上下文窗口、不支持图片输入的模型描述。
// 详情：多数模型没有经过验证的图片输入协议，用这个帮助函数省掉逐个模型重复
// `imageInput: UNSUPPORTED_IMAGE_INPUT`。
function textModel(contextWindowTokens: number): ModelDescriptor {
  return { contextWindowTokens, imageInput: UNSUPPORTED_IMAGE_INPUT }
}

// 简介：DeepSeek 的能力描述。
// 详情：只保留 V4 双模型；下线旧名 deepseek-chat / deepseek-reasoner 不再是合法选项，
// 旧会话经 state/persistence/modelMigration.ts 的映射迁到 v4-flash。
const deepseekDescriptor: VendorDescriptor = {
  contextWindowTokens: 64_000,
  maxTurnTools: 128,
  models: {
    'deepseek-v4-pro': textModel(1_000_000),
    'deepseek-v4-flash': textModel(1_000_000),
  },
}

// 简介：GLM 的能力描述。
const glmDescriptor: VendorDescriptor = {
  contextWindowTokens: 128_000,
  maxTurnTools: 128,
  models: {
    'glm-5.2': textModel(1_000_000),
    'glm-5.1': textModel(200_000),
    'glm-5': textModel(200_000),
    'glm-5-turbo': textModel(200_000),
    'glm-4.7': textModel(200_000),
    'glm-4.7-flashx': textModel(200_000),
    'glm-4.7-flash': textModel(200_000),
    'glm-4.6': textModel(200_000),
    'glm-4.5-air': textModel(128_000),
    'glm-4.5-airx': textModel(128_000),
    'glm-4.5-flash': textModel(128_000),
    'glm-4-long': textModel(1_000_000),
    'glm-4-flashx-250414': textModel(128_000),
    'glm-4-flash-250414': textModel(128_000),
  },
}

// 简介：Kimi 的能力描述。
const kimiDescriptor: VendorDescriptor = {
  contextWindowTokens: 131_072,
  maxTurnTools: 128,
  models: {
    'kimi-k2.6': {
      contextWindowTokens: 262_144,
      imageInput: KIMI_K2_6_IMAGE_INPUT,
    },
  },
}

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
  descriptor: deepseekDescriptor,
  call: (request, options) => callDeepSeek(deepseekRequest(request), options),
  stream: (request, options, handlers, retryObserver) =>
    streamDeepSeek(deepseekRequest(request), options, handlers, retryObserver),
}

const glmAdapter: ProviderAdapter<GlmProviderSettings> = {
  descriptor: glmDescriptor,
  call: (request, options) => callGlm(glmRequest(request), options),
  stream: (request, options, handlers) => streamGlm(glmRequest(request), options, handlers),
}

const kimiAdapter: ProviderAdapter<KimiProviderSettings> = {
  descriptor: kimiDescriptor,
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
