// Audited built-in model catalog shared by provider adapters and product UI.

import {
  DEEPSEEK_VISION_IMAGE_INPUT,
  KIMI_K2_6_IMAGE_INPUT,
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
const GLM_THINKING_SOURCE = 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking'
const KIMI_THINKING_SOURCE =
  'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking'

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
const KIMI_IMAGE_INPUT = freezeImageCapability(KIMI_K2_6_IMAGE_INPUT)

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

function freezeCapability(
  capability: ModelThinkingCapability,
): ModelThinkingCapability {
  return Object.freeze({ ...capability })
}

const DEEPSEEK_THINKING = freezeEffortCapability({
  sourceUrl: DEEPSEEK_THINKING_SOURCE,
  defaultEnabled: true,
  efforts: ['high', 'max'],
  effortMappings: { low: 'high', medium: 'high', xhigh: 'max' },
})

const GLM_5_2_THINKING = freezeEffortCapability({
  sourceUrl: GLM_THINKING_SOURCE,
  defaultEnabled: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  effortMappings: { low: 'high', medium: 'high', xhigh: 'max' },
  disabledAliases: ['minimal', 'none'],
})

const GLM_TOGGLE_THINKING = freezeCapability({
  kind: 'toggle',
  sourceUrl: GLM_THINKING_SOURCE,
  defaultEnabled: true,
})

const GLM_UNSUPPORTED_THINKING = freezeCapability({
  kind: 'unsupported',
  sourceUrl: GLM_THINKING_SOURCE,
})

const KIMI_TOGGLE_THINKING = freezeCapability({
  kind: 'toggle',
  sourceUrl: KIMI_THINKING_SOURCE,
  defaultEnabled: true,
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
  [GLM_VENDOR_ID]: vendorDescriptor(128_000, {
    'glm-5.2': textModel('GLM-5.2', 1_000_000, GLM_5_2_THINKING),
    'glm-5.1': textModel('GLM-5.1', 200_000, GLM_TOGGLE_THINKING),
    'glm-5': textModel('GLM-5', 200_000, GLM_TOGGLE_THINKING),
    'glm-5-turbo': textModel('GLM-5-Turbo', 200_000, GLM_TOGGLE_THINKING),
    'glm-4.7': textModel('GLM-4.7', 200_000, GLM_TOGGLE_THINKING),
    'glm-4.7-flashx': textModel('GLM-4.7-FlashX', 200_000, GLM_TOGGLE_THINKING),
    'glm-4.7-flash': textModel('GLM-4.7-Flash', 200_000, GLM_TOGGLE_THINKING),
    'glm-4.6': textModel('GLM-4.6', 200_000, GLM_TOGGLE_THINKING),
    'glm-4.5-air': textModel('GLM-4.5-Air', 128_000, GLM_TOGGLE_THINKING),
    'glm-4.5-airx': textModel('GLM-4.5-AirX', 128_000, GLM_TOGGLE_THINKING),
    'glm-4.5-flash': textModel('GLM-4.5-Flash', 128_000, GLM_TOGGLE_THINKING),
    'glm-4-long': textModel('GLM-4-Long', 1_000_000, GLM_UNSUPPORTED_THINKING),
    'glm-4-flashx-250414': textModel('GLM-4-FlashX-250414', 128_000, GLM_UNSUPPORTED_THINKING),
    'glm-4-flash-250414': textModel('GLM-4-Flash-250414', 128_000, GLM_UNSUPPORTED_THINKING),
  }),
  [KIMI_VENDOR_ID]: vendorDescriptor(131_072, {
    'kimi-k2.6': Object.freeze({
      displayName: 'Kimi K2.6',
      contextWindowTokens: 262_144,
      imageInput: KIMI_IMAGE_INPUT,
      thinking: KIMI_TOGGLE_THINKING,
    }),
  }),
  [OPENAI_COMPAT_VENDOR_ID]: vendorDescriptor(64_000, {}),
})

export function builtinVendorDescriptor(vendorId: string): VendorDescriptor {
  const descriptor = BUILTIN_VENDOR_DESCRIPTORS[vendorId]
  if (descriptor === undefined) throw new Error(`Unknown built-in provider: ${vendorId}`)
  return descriptor
}
