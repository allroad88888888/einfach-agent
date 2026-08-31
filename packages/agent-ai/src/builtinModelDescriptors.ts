// Audited built-in model catalog shared by provider adapters and product UI.

import {
  DEEPSEEK_VISION_IMAGE_INPUT,
  KIMI_K3_IMAGE_INPUT,
  UNSUPPORTED_IMAGE_INPUT,
  type ImageInputCapability,
} from './imageCapability'
import type {
  EffortThinkingCapability,
  ModelThinkingCapability,
} from './modelThinkingCapability'
import type { ModelDescriptor, VendorDescriptor } from './providerRegistry'

export const DEEPSEEK_VENDOR_ID = 'deepseek'
export const GLM_VENDOR_ID = 'glm'
export const KIMI_VENDOR_ID = 'kimi'
export const OPENAI_COMPAT_VENDOR_ID = 'openai-compat'

const DEEPSEEK_THINKING_SOURCE = 'https://api-docs.deepseek.com/guides/thinking_mode'
const GLM_THINKING_SOURCE = 'https://docs.bigmodel.cn/cn/guide/start/concept-param'
const KIMI_THINKING_SOURCE = 'https://platform.kimi.ai/docs/api/models-overview'

function freezeImageCapability(capability: ImageInputCapability): ImageInputCapability {
  if (capability.kind === 'unsupported') return Object.freeze({ ...capability })
  return Object.freeze({
    ...capability,
    accept: Object.freeze([...capability.accept]),
    limits: Object.freeze({ ...capability.limits }),
  })
}

const TEXT_IMAGE_INPUT = freezeImageCapability(UNSUPPORTED_IMAGE_INPUT)
const DEEPSEEK_IMAGE_INPUT = freezeImageCapability(DEEPSEEK_VISION_IMAGE_INPUT)
const KIMI_IMAGE_INPUT = freezeImageCapability(KIMI_K3_IMAGE_INPUT)

function freezeEffortCapability(
  capability: Omit<EffortThinkingCapability, 'kind'>,
): EffortThinkingCapability {
  return Object.freeze({
    kind: 'effort',
    ...capability,
    efforts: Object.freeze([...capability.efforts]),
    effortMappings: capability.effortMappings === undefined
      ? undefined
      : Object.freeze({ ...capability.effortMappings }),
    disabledAliases: capability.disabledAliases === undefined
      ? undefined
      : Object.freeze([...capability.disabledAliases]),
  })
}

const DEEPSEEK_THINKING = freezeEffortCapability({
  sourceUrl: DEEPSEEK_THINKING_SOURCE,
  defaultEnabled: true,
  efforts: ['low', 'high', 'max'],
  effortMappings: { low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' },
})

const GLM_5_3_THINKING = freezeEffortCapability({
  sourceUrl: GLM_THINKING_SOURCE,
  defaultEnabled: true,
  required: true,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
})

const KIMI_K3_THINKING = freezeEffortCapability({
  sourceUrl: KIMI_THINKING_SOURCE,
  defaultEnabled: true,
  required: true,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
})

function textModel(
  displayName: string,
  contextWindowTokens: number,
  thinking: ModelThinkingCapability,
): ModelDescriptor {
  return Object.freeze({
    displayName,
    contextWindowTokens,
    imageInput: TEXT_IMAGE_INPUT,
    thinking,
  })
}

function vendorDescriptor(
  contextWindowTokens: number,
  models: Readonly<Record<string, ModelDescriptor>>,
): VendorDescriptor {
  return Object.freeze({ contextWindowTokens, maxTurnTools: 128, models: Object.freeze(models) })
}

export const BUILTIN_VENDOR_DESCRIPTORS: Readonly<Record<string, VendorDescriptor>> = Object.freeze({
  [DEEPSEEK_VENDOR_ID]: vendorDescriptor(64_000, {
    'deepseek-v4-pro': textModel('DeepSeek V4 Pro', 1_000_000, DEEPSEEK_THINKING),
    'deepseek-v4-flash': textModel('DeepSeek V4 Flash', 1_000_000, DEEPSEEK_THINKING),
    'deepseek-v4-flash-vision-exp': Object.freeze({
      displayName: 'DeepSeek V4 Flash Vision Experimental',
      contextWindowTokens: 1_000_000,
      imageInput: DEEPSEEK_IMAGE_INPUT,
      thinking: DEEPSEEK_THINKING,
    }),
  }),
  [GLM_VENDOR_ID]: vendorDescriptor(1_000_000, {
    'glm-5.3': textModel('GLM-5.3', 1_000_000, GLM_5_3_THINKING),
    'glm-5.3-flash': textModel('GLM-5.3-Flash', 1_000_000, GLM_5_3_THINKING),
  }),
  [KIMI_VENDOR_ID]: vendorDescriptor(1_000_000, {
    'kimi-k3': Object.freeze({
      displayName: 'Kimi K3',
      contextWindowTokens: 1_000_000,
      imageInput: KIMI_IMAGE_INPUT,
      thinking: KIMI_K3_THINKING,
    }),
  }),
  [OPENAI_COMPAT_VENDOR_ID]: vendorDescriptor(64_000, {}),
})

export function builtinVendorDescriptor(vendorId: string): VendorDescriptor {
  const descriptor = BUILTIN_VENDOR_DESCRIPTORS[vendorId]
  if (descriptor === undefined) throw new Error(`Unknown built-in provider: ${vendorId}`)
  return descriptor
}
