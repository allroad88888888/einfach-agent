// 厂商能力查询：把不透明的 vendorId/model 翻译成上下文窗口、单轮工具上限与图片输入能力。
// ---------------------------------------------------------------------------
// 本文件不持有任何厂商数据——三家的能力描述随 adapter 一起注册在 ./builtinProviders，
// 这里只经 defaultProviderRegistry 查询。新增厂商只需要改 builtinProviders 一处。

import { defaultProviderRegistry } from './builtinProviders'
import { UNSUPPORTED_IMAGE_INPUT, type ImageInputCapability } from './imageCapability'
import type { VendorDescriptor } from './providerRegistry'

/** Returns provider capabilities, falling back safely for an unknown vendor. */
export function vendorDescriptorFor(vendor: string): VendorDescriptor {
  return defaultProviderRegistry.describe(vendor.toLowerCase())
}

/** Returns the exact known-model context window or its vendor's conservative default. */
export function contextWindowTokens(vendor: string, model: string): number {
  const descriptor = vendorDescriptorFor(vendor)
  return descriptor.models[model.toLowerCase()]?.contextWindowTokens ?? descriptor.contextWindowTokens
}

/** Returns the largest tool manifest the provider may receive in one model turn. */
export function maxTurnToolsForVendor(vendor: string): number {
  return vendorDescriptorFor(vendor).maxTurnTools
}

/** Returns verified image support only for an exact known model. */
export function imageInputCapability(vendor: string, model: string): ImageInputCapability {
  const descriptor = vendorDescriptorFor(vendor)
  return descriptor.models[model.toLowerCase()]?.imageInput ?? UNSUPPORTED_IMAGE_INPUT
}
