// 内置四家 provider 的装配：把 deepseek/glm/kimi/openai-compat 连同各自能力描述装进默认 registry。
// ---------------------------------------------------------------------------
// 参照 Rust 侧「装配层显式列举合法」：这里是 adapter 包内唯一允许出现厂商名与厂商能力数据
// （上下文窗口、单轮工具上限、逐模型清单）的地方。每家的私有请求字段都在自己的 adapter 里
// 从通用 ProviderSettings 投影出来，registry 与上层路由（modelAdapter）都不认识这些字段；
// 能力描述同理只在这里出现，vendorDescriptor.ts 只经 registry 查询、不再持有厂商数据。
// 默认 registry 的 fallback 是 deepseek —— 未注册的 vendorId 沿用历史行为按 DeepSeek 执行。
// 新增 provider 只在本文件加一段 adapter + descriptor 并注册：ModelAdapterSettings 已经是
// 「不透明 vendorId + 各家私有字段」的开放形状，没有需要同步扩的判别式，packages/agent-core
// 全程不需要知道。

import {
  callDeepSeek,
  streamDeepSeek,
  DEFAULT_DEEPSEEK_MODEL,
  type DeepSeekChatRequest,
  type DeepSeekReasoningEffort,
} from './deepseek'
import { callGlm, streamGlm, type GlmChatRequest, type GlmReasoningEffort } from './glm'
import { KIMI_K2_6_IMAGE_INPUT, UNSUPPORTED_IMAGE_INPUT } from './imageCapability'
import { callKimi, streamKimi, type KimiChatRequest } from './kimi'
import type { KimiRegion } from './kimiRegion'
import {
  callOpenAiCompat,
  streamOpenAiCompat,
  type OpenAiCompatChatRequest,
} from './openaiCompat'
import type { ChatCallOptions } from './modelApi'
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
export const OPENAI_COMPAT_VENDOR_ID = 'openai-compat'

// 简介：内置装配的缺省会话模型（vendorId + 模型名）。
// 详情：core 不认识任何厂商，因此「新会话默认用谁」这件事只能由认识厂商的一侧给出。
// 与 defaultProviderRegistry 的 fallbackVendorId 同源：两者都表达「没有别的信息时按内置
// 第一家处理」。宿主想换默认家，用 RuntimeConfig.defaultModelSettings 覆盖，不改 core。
export const DEFAULT_MODEL_SETTINGS: { readonly vendor: string; readonly model: string } = {
  vendor: DEEPSEEK_VENDOR_ID,
  model: DEFAULT_DEEPSEEK_MODEL,
}

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

// 简介：标准 OpenAI-compatible 协议的能力描述。
// 详情：这是唯一一家没有具体产品背书的 vendor——任何声称兼容 OpenAI /chat/completions
// 的端点都可能挂在这里，因此不编具体厂商才会有的数字：contextWindowTokens/maxTurnTools
// 取与 registry 自身 FALLBACK_VENDOR_DESCRIPTOR 一致的保守值，models 留空（没有实测数据
// 支撑任何一条逐模型覆盖）。接入某个具体服务后如果有了真实数据，再回来补 models。
const openAiCompatDescriptor: VendorDescriptor = {
  contextWindowTokens: 64_000,
  maxTurnTools: 128,
  models: {},
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

// 简介：标准协议没有厂商私有字段可归一，请求体原样转发；userId 不上行。
function openAiCompatRequest(request: ProviderRequest<ProviderSettings>): OpenAiCompatChatRequest {
  return { ...request.body }
}

// 简介：装配层可选的默认接入点。
// 详情：per-request 的 settings.baseUrl 优先于这里；两者都缺失时交给
// callOpenAiCompat/streamOpenAiCompat 自己的 requireBaseUrl 报配置错误，不在这里重复校验。
export interface OpenAiCompatAdapterConfig {
  baseUrl?: string
}

// 简介：解析这次调用实际要用的 ChatCallOptions.baseUrl。
// 详情：优先级 settings.baseUrl（per-request 覆盖）> config.baseUrl（装配层注册时烘焙的
// 默认接入点）> options.baseUrl（调用方直接传的，兜底给非 core 的直接调用方，比如测试）。
function resolveOpenAiCompatOptions(
  request: ProviderRequest<ProviderSettings>,
  options: ChatCallOptions,
  config: OpenAiCompatAdapterConfig,
): ChatCallOptions {
  return { ...options, baseUrl: request.settings.baseUrl ?? config.baseUrl ?? options.baseUrl }
}

// 简介：构造标准 OpenAI-compatible adapter。
// 详情：baseUrl 没有厂商官方值可猜，因此拆成两层可配——装配层在注册时可以烘焙一个默认
// 接入点（比如 CLI/桌面从环境变量解析出的自建网关地址），每次请求仍可用 settings.baseUrl
// 覆盖它。默认注册（见 registerBuiltinProviders）不带任何默认值，两者都缺失时请求会带着
// OpenAiCompatConfigError 拒绝，而不是发给未知主机。
export function createOpenAiCompatAdapter(
  config: OpenAiCompatAdapterConfig = {},
): ProviderAdapter<ProviderSettings> {
  return {
    descriptor: openAiCompatDescriptor,
    call: (request, options) =>
      callOpenAiCompat(openAiCompatRequest(request), resolveOpenAiCompatOptions(request, options, config)),
    stream: (request, options, handlers) =>
      streamOpenAiCompat(
        openAiCompatRequest(request),
        resolveOpenAiCompatOptions(request, options, config),
        handlers,
      ),
  }
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

// 默认注册不烘焙任何接入点；宿主想要一个进程级默认 baseUrl 时，用
// `registry.register(OPENAI_COMPAT_VENDOR_ID, createOpenAiCompatAdapter({ baseUrl }))`
// 覆盖它（registry 的「重复注册以最后一次为准」语义，见 providerRegistry.ts）。
const openAiCompatAdapter = createOpenAiCompatAdapter()

// 简介：把内置四家注册进给定 registry。
// 详情：宿主想要一个只带部分厂商的隔离 registry 时，可以自建实例再选择性注册。
export function registerBuiltinProviders(registry: ProviderRegistry): void {
  registry.register(DEEPSEEK_VENDOR_ID, deepseekAdapter)
  registry.register(GLM_VENDOR_ID, glmAdapter)
  registry.register(KIMI_VENDOR_ID, kimiAdapter)
  registry.register(OPENAI_COMPAT_VENDOR_ID, openAiCompatAdapter)
}

// 简介：默认 provider registry（modelAdapter 的分发表）。
// 详情：模块加载即完成四家注册；fallback 到 DeepSeek 保持未知 vendor 的历史回退语义。
export const defaultProviderRegistry: ProviderRegistry = createProviderRegistry({
  fallbackVendorId: DEEPSEEK_VENDOR_ID,
})

registerBuiltinProviders(defaultProviderRegistry)
