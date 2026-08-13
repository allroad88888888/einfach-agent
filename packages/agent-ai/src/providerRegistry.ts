// Provider 注册表：把不透明的 vendorId 解析成执行请求的 adapter，并携带各家的能力描述。
// ---------------------------------------------------------------------------
// 这一层只回答「谁来执行」与「这家能力如何」，本身不认识任何厂商：厂商私有的请求投影
// （DeepSeek 的 reasoning_effort/user_id、GLM 的 reasoning_effort、Kimi 的 region 等）与
// 能力描述（上下文窗口、单轮工具上限、逐模型能力）一律随 adapter 一起注册。内置三家的
// 装配表在 ./builtinProviders，那里是包内唯一允许出现厂商名与厂商能力数据的地方。

import type { ImageInputCapability } from './imageCapability'
import type {
  ChatCallOptions,
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
  ModelRetryObserver,
} from './modelApi'

// 简介：运行时模型设置的通用形状。
// 详情：所有厂商唯一共有的字段就是 vendorId；其余字段是各家私有的，registry 不看。
export interface ProviderSettings {
  vendor: string
  // 简介：调用方要求的接入点覆盖（可选）。
  // 详情：不透明、非厂商专名——registry 与更上层的 core 都不解释这个字段，只有 adapter
  // 自己决定要不要消费它。标准 OpenAI-compatible 协议没有官方端点，靠这个字段（或 adapter
  // 注册时装配层烘焙的默认值）才能拿到 baseUrl；deepseek/glm/kimi 各自有域名常量，忽略它。
  baseUrl?: string
}

// 简介：交给 adapter 执行的通用请求。
// 详情：body 是 provider-neutral 的线协议请求体；settings 尚未归一，由 adapter 自行投影；
// userId 是可选的调用方标识（是否上行、上行成什么字段同样由 adapter 决定）。
export interface ProviderRequest<TSettings extends ProviderSettings = ProviderSettings> {
  body: ChatRequestBase
  settings: TSettings
  userId?: string
}

// 简介：单个模型的能力描述，供 runtime 只读消费，不依赖任何厂商私有代码。
export interface ModelDescriptor {
  readonly contextWindowTokens: number
  readonly imageInput: ImageInputCapability
}

// 简介：一家 provider 的能力描述。
// 详情：contextWindowTokens/maxTurnTools 是 vendor 级别的保守默认值；models 是逐模型覆盖表，
// 未知模型回退到 vendor 级别默认值。
export interface VendorDescriptor {
  readonly contextWindowTokens: number
  readonly maxTurnTools: number
  readonly models: Readonly<Record<string, ModelDescriptor>>
}

// 简介：未注册厂商的保守能力描述。
// 详情：这是 registry 机制自身的兜底，与任何具体厂商无关——即使 fallbackVendorId 指向的
// adapter 也未注册，描述查询依然要有值可用，而不是抛错或返回 undefined。
const FALLBACK_VENDOR_DESCRIPTOR: VendorDescriptor = {
  contextWindowTokens: 64_000,
  maxTurnTools: 128,
  models: {},
}

// 简介：一家 provider 的执行契约与能力描述。
// 详情：call/stream 两个入口对应非流式与流式；retryObserver 只有实现了厂商级重试的 adapter
// 才会消费。descriptor 与 call/stream 一起注册，新增厂商时能力表和执行逻辑落在同一处。
// 泛型参数让各家 adapter 在实现内部拿到自己的设置形状，registry 侧按通用形状擦除保存。
export interface ProviderAdapter<TSettings extends ProviderSettings = ProviderSettings> {
  descriptor: VendorDescriptor
  call(
    request: ProviderRequest<TSettings>,
    options: ChatCallOptions,
  ): Promise<ModelChatResponse>
  stream(
    request: ProviderRequest<TSettings>,
    options: ChatCallOptions,
    handlers?: ChatStreamHandlers,
    retryObserver?: ModelRetryObserver,
  ): Promise<ModelChatResponse>
}

export interface ProviderRegistryOptions {
  // 简介：解析不到 vendorId 时的回退目标。
  // 详情：留空则未知 vendorId 解析为 undefined；默认 registry 用它保持「未知厂商按
  // DeepSeek 处理」的历史语义。
  fallbackVendorId?: string
}

export interface ProviderRegistry {
  // 简介：注册一个 vendorId 的 adapter；vendorId 是不透明小写字符串。
  // 详情：重复注册以最后一次为准（后注册覆盖先注册），便于宿主替换内置实现。
  register(vendorId: string, adapter: ProviderAdapter): void
  // 简介：解析 vendorId 对应的 adapter。
  // 详情：未注册时回退到 fallbackVendorId 的 adapter；连回退目标都没有才返回 undefined。
  resolve(vendorId: string): ProviderAdapter | undefined
  // 简介：查询 vendorId 的能力描述。
  // 详情：故意不复用 resolve() 的 fallbackVendorId 链——未注册的 vendorId 应该拿到与任何
  // 具体厂商无关的保守默认值，而不是被误判成拥有 fallback 厂商的具体模型清单。
  describe(vendorId: string): VendorDescriptor
}

// 简介：创建一个独立的 provider registry。
// 详情：实例之间互不共享注册表，测试与多宿主装配可以各建各的。
export function createProviderRegistry(
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>()
  const { fallbackVendorId } = options

  return {
    register(vendorId, adapter) {
      adapters.set(vendorId, adapter)
    },
    resolve(vendorId) {
      const adapter = adapters.get(vendorId)
      if (adapter !== undefined) return adapter
      return fallbackVendorId === undefined ? undefined : adapters.get(fallbackVendorId)
    },
    describe(vendorId) {
      return adapters.get(vendorId)?.descriptor ?? FALLBACK_VENDOR_DESCRIPTOR
    },
  }
}
