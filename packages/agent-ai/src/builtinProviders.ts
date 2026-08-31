// 内置四家 provider 的装配：把 deepseek/glm/kimi/openai-compat adapter 装进默认 registry。
// ---------------------------------------------------------------------------
// 逐模型 catalog 在 builtinModelDescriptors；这里仅把 catalog 与厂商请求投影组装成 adapter。
// 每家的私有请求字段都在自己的 adapter 里从通用 ProviderSettings 投影出来，registry 与上层
// 路由（modelAdapter）都不认识这些字段。
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
import { callKimi, streamKimi, type KimiChatRequest } from './kimi'
import type { KimiRegion } from './kimiRegion'
import {
  callOpenAiCompat,
  streamOpenAiCompat,
  type OpenAiCompatChatRequest,
} from './openaiCompat'
import type { ChatCallOptions } from './modelApi'
import type { ChatRequestBase, ThinkingConfig } from './modelProtocol'
import {
  UNKNOWN_THINKING_CAPABILITY,
  getModelThinkingCapability,
  isDisabledThinkingAlias,
  isSupportedThinkingEffort,
  modelRequiresThinking,
  modelSupportsThinking,
  type ModelThinkingCapability,
  type ModelThinkingCapabilityRegistry,
  type ModelThinkingEffort,
} from './modelThinkingCapability'
import { markLegacyOpenAiCompat } from './providerLocalTransport'
import {
  DEEPSEEK_VENDOR_ID,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
  BUILTIN_VENDOR_DESCRIPTORS,
  builtinVendorDescriptor,
} from './builtinModelDescriptors'
import {
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderRegistry,
  type ProviderRequest,
  type ProviderSettings,
} from './providerRegistry'

export {
  DEEPSEEK_VENDOR_ID,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
} from './builtinModelDescriptors'

// 简介：内置装配的缺省会话模型（vendorId + 模型名）。
// 详情：core 不认识任何厂商，因此「新会话默认用谁」这件事只能由认识厂商的一侧给出。
// 与 defaultProviderRegistry 的 fallbackVendorId 同源：两者都表达「没有别的信息时按内置
// 第一家处理」。宿主想换默认家，用 RuntimeConfig.defaultModelSettings 覆盖，不改 core。
export const DEFAULT_MODEL_SETTINGS: { readonly vendor: string; readonly model: string } = {
  vendor: DEEPSEEK_VENDOR_ID,
  model: DEFAULT_DEEPSEEK_MODEL,
}

type ThinkingProviderSettings = ProviderSettings & { reasoning_effort?: unknown }
type DeepSeekProviderSettings = ThinkingProviderSettings
type GlmProviderSettings = ThinkingProviderSettings
type KimiProviderSettings = ProviderSettings & { region?: KimiRegion }
type OpenAiCompatProviderSettings = ProviderSettings & { connectionId?: string }

type ThinkingProjectedRequest = Omit<ChatRequestBase, 'thinking'> & {
  thinking?: ThinkingConfig
  reasoning_effort?: ModelThinkingEffort
}

const BUILTIN_THINKING_CAPABILITIES: ModelThinkingCapabilityRegistry = {
  describeModel(vendorId, modelId) {
    return BUILTIN_VENDOR_DESCRIPTORS[vendorId]?.models[modelId]
  },
}

function canonicalThinking(value: unknown): ThinkingConfig | undefined {
  const type = value !== null && typeof value === 'object'
    ? (value as { type?: unknown }).type
    : undefined
  return type === 'enabled' || type === 'disabled' ? { type } : undefined
}

/** Exact capability lookup: execution fallback must not inherit a vendor's private Thinking fields. */
function thinkingCapabilityFor(
  request: ProviderRequest<ProviderSettings>,
  vendorId: string,
): ModelThinkingCapability {
  if (request.settings.vendor !== vendorId) return UNKNOWN_THINKING_CAPABILITY
  return getModelThinkingCapability(BUILTIN_THINKING_CAPABILITIES, vendorId, request.body.model)
}

/** Projects only the documented Thinking fields for the request's exact vendor and model. */
function projectThinkingRequest(
  request: ProviderRequest<ThinkingProviderSettings>,
  vendorId: string,
): ThinkingProjectedRequest {
  const capability = thinkingCapabilityFor(request, vendorId)
  const body = request.body as ChatRequestBase & { reasoning_effort?: unknown }
  const { thinking: rawThinking, reasoning_effort: _untrustedEffort, ...base } = body
  const thinking = canonicalThinking(rawThinking)

  if (!modelSupportsThinking(capability)) return base
  if (capability.kind === 'toggle') return thinking === undefined ? base : { ...base, thinking }

  const effort = request.settings.reasoning_effort
  if (isDisabledThinkingAlias(capability, effort)) {
    return { ...base, thinking: { type: 'disabled' } }
  }
  if (thinking?.type !== 'enabled') return thinking === undefined ? base : { ...base, thinking }
  if (!isSupportedThinkingEffort(capability, effort)) return { ...base, thinking }
  return { ...base, thinking, reasoning_effort: effort }
}

// 简介：DeepSeek 的请求投影。
// 详情：DeepSeek 是唯一消费 userId 的厂商（上行为 user_id），并有自己的 reasoning_effort 取值域。
function deepseekRequest(
  request: ProviderRequest<DeepSeekProviderSettings>,
): DeepSeekChatRequest {
  const { reasoning_effort, ...body } = projectThinkingRequest(request, DEEPSEEK_VENDOR_ID)
  return {
    ...body,
    ...(reasoning_effort === 'low' || reasoning_effort === 'high' || reasoning_effort === 'max'
      ? { reasoning_effort: reasoning_effort as DeepSeekReasoningEffort }
      : {}),
    user_id: request.userId,
  }
}

// 简介：GLM 的请求投影。
// 详情：只归一 GLM-5.3 系列的 reasoning_effort；userId 不上行。
function glmRequest(request: ProviderRequest<GlmProviderSettings>): GlmChatRequest {
  const capability = thinkingCapabilityFor(request, GLM_VENDOR_ID)
  const projected = projectThinkingRequest(request, GLM_VENDOR_ID)
  const required = modelRequiresThinking(capability)
  const reasoningEffort = required
    && isSupportedThinkingEffort(capability, request.settings.reasoning_effort)
    ? request.settings.reasoning_effort
    : projected.reasoning_effort
  const { reasoning_effort: _projectedEffort, ...body } = projected
  return {
    ...body,
    ...(required ? { thinking: { type: 'enabled' } as const } : {}),
    ...(reasoningEffort === 'low'
      || reasoningEffort === 'high'
      || reasoningEffort === 'max'
      ? { reasoning_effort: reasoningEffort as GlmReasoningEffort }
      : {}),
  }
}

// 简介：Kimi 的请求投影。
// 详情：只归一 region（决定接入点与引用 scope）；userId 不上行。
function kimiRequest(request: ProviderRequest<KimiProviderSettings>): KimiChatRequest {
  const { reasoning_effort: _reasoningEffort, ...body } = projectThinkingRequest(request, KIMI_VENDOR_ID)
  return { ...body, region: request.settings.region }
}

// 简介：标准协议没有厂商私有字段可归一，请求体原样转发；userId 不上行。
function openAiCompatRequest(
  request: ProviderRequest<OpenAiCompatProviderSettings>,
): OpenAiCompatChatRequest {
  const { reasoning_effort: _reasoningEffort, ...body } = projectThinkingRequest(
    request,
    OPENAI_COMPAT_VENDOR_ID,
  )
  return body
}

// 简介：装配层登记的 legacy 接入点。
// 详情：会话里的 settings.baseUrl 不可信；无 connectionId 时只能使用这一条登记值。
export interface OpenAiCompatAdapterConfig {
  baseUrl?: string
  /** Resolves profile endpoints from the application's hydrated public registry. */
  connectionBaseUrl?: (connectionId: string) => string | undefined
}

// 简介：解析这次调用实际要用的 ChatCallOptions.baseUrl 与本地身份。
// 详情：有 connectionId 时只查装配层的公开 profile registry；无 ID 时只用装配层登记的
// legacy origin，并加上固定身份。会话设置与调用 options 都不能改写 endpoint。
function resolveOpenAiCompatOptions(
  request: ProviderRequest<OpenAiCompatProviderSettings>,
  options: ChatCallOptions,
  config: OpenAiCompatAdapterConfig,
): ChatCallOptions {
  const connectionId = request.settings.connectionId
  if (connectionId !== undefined) {
    return {
      ...options,
      baseUrl: config.connectionBaseUrl?.(connectionId),
      connectionId,
    }
  }
  return markLegacyOpenAiCompat({ ...options, baseUrl: config.baseUrl })
}

// 简介：构造标准 OpenAI-compatible adapter。
// 详情：baseUrl 没有厂商官方值可猜，因此只能由装配层烘焙登记值。默认注册
// （见 registerBuiltinProviders）不带默认值；缺失时请求以 OpenAiCompatConfigError 拒绝。
export function createOpenAiCompatAdapter(
  config: OpenAiCompatAdapterConfig = {},
): ProviderAdapter<ProviderSettings> {
  return {
    descriptor: builtinVendorDescriptor(OPENAI_COMPAT_VENDOR_ID),
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
  descriptor: builtinVendorDescriptor(DEEPSEEK_VENDOR_ID),
  call: (request, options) => callDeepSeek(deepseekRequest(request), options),
  stream: (request, options, handlers, retryObserver) =>
    streamDeepSeek(deepseekRequest(request), options, handlers, retryObserver),
}

const glmAdapter: ProviderAdapter<GlmProviderSettings> = {
  descriptor: builtinVendorDescriptor(GLM_VENDOR_ID),
  call: (request, options) => callGlm(glmRequest(request), options),
  stream: (request, options, handlers) => streamGlm(glmRequest(request), options, handlers),
}

const kimiAdapter: ProviderAdapter<KimiProviderSettings> = {
  descriptor: builtinVendorDescriptor(KIMI_VENDOR_ID),
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
