// Provider 注册表：把不透明的 vendorId 解析成执行请求的 adapter。
// ---------------------------------------------------------------------------
// 这一层只回答「谁来执行」，本身不认识任何厂商：厂商私有的请求投影（DeepSeek 的
// reasoning_effort/user_id、GLM 的 reasoning_effort、Kimi 的 region 等）一律由各家 adapter
// 在 call/stream 内部从通用设置归一出来。内置三家的装配表在 ./builtinProviders。

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
}

// 简介：交给 adapter 执行的通用请求。
// 详情：body 是 provider-neutral 的线协议请求体；settings 尚未归一，由 adapter 自行投影；
// userId 是可选的调用方标识（是否上行、上行成什么字段同样由 adapter 决定）。
export interface ProviderRequest<TSettings extends ProviderSettings = ProviderSettings> {
  body: ChatRequestBase
  settings: TSettings
  userId?: string
}

// 简介：一家 provider 的执行契约。
// 详情：两个入口对应非流式与流式；retryObserver 只有实现了厂商级重试的 adapter 才会消费。
// 泛型参数让各家 adapter 在实现内部拿到自己的设置形状，registry 侧按通用形状擦除保存。
export interface ProviderAdapter<TSettings extends ProviderSettings = ProviderSettings> {
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
  }
}
