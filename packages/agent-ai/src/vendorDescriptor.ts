import {
  KIMI_K2_6_IMAGE_INPUT,
  UNSUPPORTED_IMAGE_INPUT,
  type ImageInputCapability,
} from './imageCapability'

/** Provider capabilities used by the runtime without depending on provider-specific core code. */
export interface ModelDescriptor {
  readonly contextWindowTokens: number
  readonly imageInput: ImageInputCapability
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

function textModel(contextWindowTokens: number): ModelDescriptor {
  return { contextWindowTokens, imageInput: UNSUPPORTED_IMAGE_INPUT }
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
      'deepseek-v4-pro': textModel(1_000_000),
      'deepseek-v4-flash': textModel(1_000_000),
      'deepseek-chat': textModel(1_000_000),
      'deepseek-reasoner': textModel(1_000_000),
    },
  },
  glm: {
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
  },
  kimi: {
    contextWindowTokens: 131_072,
    maxTurnTools: 128,
    models: {
      'kimi-k2.6': {
        contextWindowTokens: 262_144,
        imageInput: KIMI_K2_6_IMAGE_INPUT,
      },
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

/** Returns verified image support only for an exact known model. */
export function imageInputCapability(vendor: string, model: string): ImageInputCapability {
  const descriptor = vendorDescriptorFor(vendor)
  return descriptor.models[model.toLowerCase()]?.imageInput ?? UNSUPPORTED_IMAGE_INPUT
}
