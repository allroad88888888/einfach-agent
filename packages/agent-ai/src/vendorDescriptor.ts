/** Provider capabilities used by the runtime without depending on provider-specific core code. */
export interface ModelDescriptor {
  readonly contextWindowTokens: number
}

export interface VendorDescriptor {
  readonly contextWindowTokens: number
  readonly maxTurnTools: number
  readonly models: Readonly<Record<string, ModelDescriptor>>
}

const FALLBACK_VENDOR_DESCRIPTOR: VendorDescriptor = {
  contextWindowTokens: 64_000,
  maxTurnTools: 128,
  models: {},
}

/**
 * Canonical provider capability table.
 *
 * Unknown models deliberately use the conservative vendor-level window; unknown
 * vendors use the conservative fallback descriptor.
 */
export const VENDOR_DESCRIPTORS = {
  deepseek: {
    contextWindowTokens: 64_000,
    maxTurnTools: 128,
    models: {
      'deepseek-v4-pro': { contextWindowTokens: 1_000_000 },
      'deepseek-v4-flash': { contextWindowTokens: 1_000_000 },
      'deepseek-chat': { contextWindowTokens: 1_000_000 },
      'deepseek-reasoner': { contextWindowTokens: 1_000_000 },
    },
  },
  glm: {
    contextWindowTokens: 128_000,
    maxTurnTools: 128,
    models: {
      'glm-5.2': { contextWindowTokens: 1_000_000 },
      'glm-5.1': { contextWindowTokens: 200_000 },
      'glm-5': { contextWindowTokens: 200_000 },
      'glm-5-turbo': { contextWindowTokens: 200_000 },
      'glm-4.7': { contextWindowTokens: 200_000 },
      'glm-4.7-flashx': { contextWindowTokens: 200_000 },
      'glm-4.7-flash': { contextWindowTokens: 200_000 },
      'glm-4.6': { contextWindowTokens: 200_000 },
      'glm-4.5-air': { contextWindowTokens: 128_000 },
      'glm-4.5-airx': { contextWindowTokens: 128_000 },
      'glm-4.5-flash': { contextWindowTokens: 128_000 },
      'glm-4-long': { contextWindowTokens: 1_000_000 },
      'glm-4-flashx-250414': { contextWindowTokens: 128_000 },
      'glm-4-flash-250414': { contextWindowTokens: 128_000 },
    },
  },
} as const satisfies Readonly<Record<string, VendorDescriptor>>

/** Returns provider capabilities, falling back safely for an unknown vendor. */
export function vendorDescriptorFor(vendor: string): VendorDescriptor {
  return VENDOR_DESCRIPTORS[vendor.toLowerCase() as keyof typeof VENDOR_DESCRIPTORS] ?? FALLBACK_VENDOR_DESCRIPTOR
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
