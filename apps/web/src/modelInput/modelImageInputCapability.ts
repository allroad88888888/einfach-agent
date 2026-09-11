import {
  OPENAI_COMPAT_BASE64_IMAGE_INPUT,
  imageInputCapability,
  type ImageInputCapability,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'

const KIMI_IMAGE_GATE_REASON = 'Kimi 图片输入尚未开放。'

/** Kimi image input stays closed unless the public build flag explicitly opts in. */
export function isKimiImageInputEnabled(): boolean {
  return import.meta.env.VITE_KIMI_IMAGE_INPUT_ENABLED === 'true'
}

/** Resolves built-in image contracts plus the current OpenAI-compatible model opt-in. */
export function imageInputCapabilityForApp(
  settings: Pick<ModelSettings, 'vendor' | 'model' | 'vendorSettings'>,
): ImageInputCapability {
  if (
    settings.vendor === 'openai-compat'
    && settings.vendorSettings?.imageInput === 'inline-base64'
  ) return OPENAI_COMPAT_BASE64_IMAGE_INPUT

  const capability = imageInputCapability(settings.vendor, settings.model)
  if (
    settings.vendor === 'kimi'
    && capability.kind === 'provider-upload'
    && !isKimiImageInputEnabled()
  ) return { kind: 'unsupported', reason: KIMI_IMAGE_GATE_REASON }
  return capability
}
